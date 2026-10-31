-- Run once in Supabase SQL Editor.
create table if not exists public.workspace_options (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null check (kind in ('setup', 'poi')),
  name text not null check (length(trim(name)) > 0),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint workspace_options_workspace_kind_name_key unique (workspace_id, kind, name)
);

alter table public.workspace_options enable row level security;

revoke all on table public.workspace_options from anon;
grant select, insert, update, delete on table public.workspace_options to authenticated;

drop policy if exists "Workspace owners can read options" on public.workspace_options;
create policy "Workspace owners can read options"
on public.workspace_options for select to authenticated
using (exists (
  select 1 from public.workspaces w
  where w.id = workspace_options.workspace_id
    and w.user_id = (select auth.uid())
));

drop policy if exists "Workspace owners can add options" on public.workspace_options;
create policy "Workspace owners can add options"
on public.workspace_options for insert to authenticated
with check (exists (
  select 1 from public.workspaces w
  where w.id = workspace_options.workspace_id
    and w.user_id = (select auth.uid())
));

drop policy if exists "Workspace owners can update options" on public.workspace_options;
create policy "Workspace owners can update options"
on public.workspace_options for update to authenticated
using (exists (
  select 1 from public.workspaces w
  where w.id = workspace_options.workspace_id
    and w.user_id = (select auth.uid())
))
with check (exists (
  select 1 from public.workspaces w
  where w.id = workspace_options.workspace_id
    and w.user_id = (select auth.uid())
));

drop policy if exists "Workspace owners can delete options" on public.workspace_options;
create policy "Workspace owners can delete options"
on public.workspace_options for delete to authenticated
using (exists (
  select 1 from public.workspaces w
  where w.id = workspace_options.workspace_id
    and w.user_id = (select auth.uid())
));
