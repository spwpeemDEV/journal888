-- Run once in Supabase SQL Editor.
create table if not exists public.workspace_shares (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references public.workspaces(id) on delete cascade,
  token_hash text not null unique,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

alter table public.workspace_shares enable row level security;
revoke all on table public.workspace_shares from anon, authenticated;
grant all on table public.workspace_shares to service_role;
