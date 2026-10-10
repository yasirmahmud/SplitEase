-- Run once in the SplitEase Supabase SQL Editor before deploying the public function.
-- This row groups unauthenticated submissions for idempotency and a shared rate limit.
-- Its token_hash fills the legacy column; the public endpoint never reads it.
insert into public.receipt_import_integrations (id, name, token_hash, active)
values (
  '00000000-0000-4000-8000-000000000001',
  'Public submissions',
  encode(digest('splitease-public-submissions-v1', 'sha256'), 'hex'),
  true
)
on conflict (id) do nothing;
