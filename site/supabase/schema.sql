create table if not exists public.splitease_state (
  id text primary key check (id = 'current'),
  version bigint not null default 1,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.splitease_acknowledgements (
  state_id text not null references public.splitease_state(id) on delete cascade,
  version bigint not null,
  person_id text not null,
  person_name text not null,
  acknowledged_at timestamptz not null default now(),
  primary key (state_id, version, person_id)
);

insert into public.splitease_state (id, version, data)
values ('current', 1, '{}'::jsonb)
on conflict (id) do nothing;

alter table public.splitease_state enable row level security;
alter table public.splitease_acknowledgements enable row level security;

revoke all on public.splitease_state from anon, authenticated;
revoke all on public.splitease_acknowledgements from anon, authenticated;
grant select, update on public.splitease_state to anon, authenticated;
grant select, insert, update, delete on public.splitease_acknowledgements to anon, authenticated;

drop policy if exists "Anyone can read the current state" on public.splitease_state;
drop policy if exists "Anyone can update the current state" on public.splitease_state;
drop policy if exists "Anyone can read acknowledgements" on public.splitease_acknowledgements;
drop policy if exists "Anyone can acknowledge current version" on public.splitease_acknowledgements;
drop policy if exists "Anyone can update current acknowledgement" on public.splitease_acknowledgements;
drop policy if exists "Anyone can remove current acknowledgement" on public.splitease_acknowledgements;

create policy "Anyone can read the current state"
on public.splitease_state for select to anon, authenticated
using (id = 'current');

create policy "Anyone can update the current state"
on public.splitease_state for update to anon, authenticated
using (id = 'current') with check (id = 'current');

create policy "Anyone can read acknowledgements"
on public.splitease_acknowledgements for select to anon, authenticated
using (state_id = 'current');

create policy "Anyone can acknowledge current version"
on public.splitease_acknowledgements for insert to anon, authenticated
with check (
  state_id = 'current'
  and version = (select version from public.splitease_state where id = 'current')
);

create policy "Anyone can update current acknowledgement"
on public.splitease_acknowledgements for update to anon, authenticated
using (state_id = 'current') with check (state_id = 'current');

create policy "Anyone can remove current acknowledgement"
on public.splitease_acknowledgements for delete to anon, authenticated
using (state_id = 'current');
