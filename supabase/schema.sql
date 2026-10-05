create table if not exists public.creator_workspace (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  payload jsonb not null default '{"creators":[],"deals":[],"contents":[]}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.creator_workspace enable row level security;

revoke all on table public.creator_workspace from anon;
grant select, insert, update on table public.creator_workspace to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'creator_workspace' and policyname = 'read own workspace'
  ) then
    execute 'create policy "read own workspace" on public.creator_workspace for select to authenticated using ((select auth.uid()) = user_id)';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'creator_workspace' and policyname = 'create own workspace'
  ) then
    execute 'create policy "create own workspace" on public.creator_workspace for insert to authenticated with check ((select auth.uid()) = user_id)';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'creator_workspace' and policyname = 'update own workspace'
  ) then
    execute 'create policy "update own workspace" on public.creator_workspace for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)';
  end if;
end
$$;

-- V2: every business item is stored independently so concurrent tabs and
-- devices cannot overwrite an entire workspace with a stale snapshot.
create table if not exists public.creator_records (
  user_id uuid not null references auth.users(id) on delete cascade,
  collection text not null check (collection in ('creators', 'deals', 'contents')),
  record_id text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, collection, record_id)
);

alter table public.creator_records enable row level security;

revoke all on table public.creator_records from anon;
grant select, insert, update, delete on table public.creator_records to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'creator_records' and policyname = 'read own records'
  ) then
    execute 'create policy "read own records" on public.creator_records for select to authenticated using ((select auth.uid()) = user_id)';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'creator_records' and policyname = 'create own records'
  ) then
    execute 'create policy "create own records" on public.creator_records for insert to authenticated with check ((select auth.uid()) = user_id)';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'creator_records' and policyname = 'update own records'
  ) then
    execute 'create policy "update own records" on public.creator_records for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'creator_records' and policyname = 'delete own records'
  ) then
    execute 'create policy "delete own records" on public.creator_records for delete to authenticated using ((select auth.uid()) = user_id)';
  end if;
end
$$;

-- Preserve every existing workspace record during the one-time upgrade.
insert into public.creator_records (user_id, collection, record_id, payload, updated_at)
select workspace.user_id, 'creators', item ->> 'id', item, workspace.updated_at
from public.creator_workspace workspace
cross join lateral jsonb_array_elements(coalesce(workspace.payload -> 'creators', '[]'::jsonb)) item
where item ? 'id'
on conflict (user_id, collection, record_id) do nothing;

insert into public.creator_records (user_id, collection, record_id, payload, updated_at)
select workspace.user_id, 'deals', item ->> 'id', item, workspace.updated_at
from public.creator_workspace workspace
cross join lateral jsonb_array_elements(coalesce(workspace.payload -> 'deals', '[]'::jsonb)) item
where item ? 'id'
on conflict (user_id, collection, record_id) do nothing;

insert into public.creator_records (user_id, collection, record_id, payload, updated_at)
select workspace.user_id, 'contents', item ->> 'id', item, workspace.updated_at
from public.creator_workspace workspace
cross join lateral jsonb_array_elements(coalesce(workspace.payload -> 'contents', '[]'::jsonb)) item
where item ? 'id'
on conflict (user_id, collection, record_id) do nothing;

-- Enable cross-tab and cross-device updates. This block is safe to run again.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'creator_records'
     ) then
    alter publication supabase_realtime add table public.creator_records;
  end if;
end
$$;
