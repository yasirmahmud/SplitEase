-- Run after schema.sql in the SplitEase Supabase SQL Editor.
create extension if not exists pgcrypto;
create table if not exists public.receipt_import_integrations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.receipt_submissions (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references public.receipt_import_integrations(id),
  external_receipt_id text not null,
  idempotency_key text not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'imported', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (integration_id, idempotency_key),
  unique (integration_id, external_receipt_id)
);

create index if not exists receipt_submissions_pending_idx on public.receipt_submissions (created_at desc) where status = 'pending';

create table if not exists public.receipt_import_rate_limits (
  integration_id uuid not null references public.receipt_import_integrations(id) on delete cascade,
  minute_start timestamptz not null,
  request_count integer not null default 0,
  primary key (integration_id, minute_start)
);

create or replace function public.allow_receipt_import(integration uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare requests integer;
begin
  insert into public.receipt_import_rate_limits (integration_id, minute_start, request_count)
  values (integration, date_trunc('minute', now()), 1)
  on conflict (integration_id, minute_start) do update
  set request_count = public.receipt_import_rate_limits.request_count + 1
  returning request_count into requests;
  return requests <= 60;
end;
$$;

alter table public.receipt_import_integrations enable row level security;
alter table public.receipt_submissions enable row level security;
alter table public.receipt_import_rate_limits enable row level security;
revoke all on public.receipt_import_integrations from anon, authenticated;
revoke all on public.receipt_submissions from anon, authenticated;
revoke all on public.receipt_import_rate_limits from anon, authenticated;
grant select on public.receipt_submissions to anon, authenticated;
revoke all on function public.allow_receipt_import(uuid) from public;
grant select on public.receipt_import_integrations to service_role;
grant select, insert on public.receipt_submissions to service_role;
grant execute on function public.allow_receipt_import(uuid) to service_role;

-- The existing workspace is public. Its pending inbox has the same visibility.
drop policy if exists "Anyone can read submitted receipts" on public.receipt_submissions;
create policy "Anyone can read submitted receipts"
on public.receipt_submissions for select to anon, authenticated using (status = 'pending');

create or replace function public.accept_receipt_import(submission_id uuid)
returns table (workspace_version bigint, workspace_data jsonb)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  submission public.receipt_submissions%rowtype;
  current_state public.splitease_state%rowtype;
  people jsonb;
  person_ids jsonb;
  imported_items jsonb;
  session_id text;
  receipt_name text;
  imported_session jsonb;
  next_data jsonb;
begin
  select * into submission from public.receipt_submissions where id = submission_id for update;
  if not found then raise exception 'Receipt submission not found' using errcode = 'P0002'; end if;
  if submission.status <> 'pending' then raise exception 'Receipt submission is already %', submission.status using errcode = 'P0001'; end if;
  select * into current_state from public.splitease_state where id = 'current' for update;
  if not found then raise exception 'SplitEase workspace is missing' using errcode = 'P0002'; end if;
  if current_state.data->>'version' <> '2' then raise exception 'SplitEase workspace must be initialized first' using errcode = 'P0001'; end if;

  select entry.session->'people' into people
  from jsonb_array_elements(current_state.data->'sessions') as entry(session)
  where entry.session->>'id' = current_state.data->>'activeSessionId' limit 1;
  people := coalesce(people, '[]'::jsonb);
  select coalesce(jsonb_agg(person.value->>'id'), '[]'::jsonb) into person_ids from jsonb_array_elements(people) as person(value);
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', 'import-item-' || ordinality::text,
    'name', item->>'name',
    'quantity', (item->>'quantity')::numeric,
    'price', (item->>'line_total_cents')::numeric / (item->>'quantity')::numeric / 100,
    'assignedTo', case when item->>'state' = 'charged' then person_ids else '[]'::jsonb end,
    'excluded', item->>'state' = 'not_charged',
    'refunded', item->>'state' = 'refunded'
  ) order by ordinality), '[]'::jsonb) into imported_items
  from jsonb_array_elements(submission.payload->'items') with ordinality as entry(item, ordinality);

  session_id := 'split-import-' || submission.id::text;
  receipt_name := (submission.payload->>'merchant') || ' · ' || (submission.payload->>'purchased_on');
  imported_session := jsonb_build_object(
    'id', session_id, 'importId', submission.id,
    'title', receipt_name, 'receiptName', receipt_name,
    'receiptSubtotal', (submission.payload->>'subtotal_cents')::numeric / 100,
    'createdAt', now(), 'updatedAt', now(),
    'people', people, 'items', imported_items,
    'adjustments', jsonb_build_object(
      'savings', (submission.payload->>'discount_cents')::numeric / 100,
      'tax', (submission.payload->>'tax_cents')::numeric / 100,
      'tip', (submission.payload->>'tip_cents')::numeric / 100,
      'delivery', (submission.payload->>'delivery_cents')::numeric / 100,
      'refund', (submission.payload->>'order_refund_cents')::numeric / 100
    ),
    'reviewedBy', '[]'::jsonb
  );
  next_data := jsonb_set(current_state.data, '{sessions}', current_state.data->'sessions' || jsonb_build_array(imported_session));
  next_data := jsonb_set(next_data, '{activeSessionId}', to_jsonb(session_id));
  update public.splitease_state set data = next_data, version = version + 1, updated_at = now() where id = 'current';
  update public.receipt_submissions set status = 'imported', updated_at = now() where id = submission_id;
  return query select current_state.version + 1, next_data;
end;
$$;

create or replace function public.reject_receipt_import(submission_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.receipt_submissions set status = 'rejected', updated_at = now()
  where id = submission_id and status = 'pending';
  if not found then raise exception 'Pending receipt submission not found' using errcode = 'P0002'; end if;
end;
$$;

revoke all on function public.accept_receipt_import(uuid) from public;
revoke all on function public.reject_receipt_import(uuid) from public;
grant execute on function public.accept_receipt_import(uuid) to anon, authenticated;
grant execute on function public.reject_receipt_import(uuid) to anon, authenticated;

-- Example token provisioning (run only in SQL Editor, replacing the name and token):
-- insert into public.receipt_import_integrations (name, token_hash)
-- values ('My processor', encode(digest('replace-with-a-long-random-token', 'sha256'), 'hex'));
