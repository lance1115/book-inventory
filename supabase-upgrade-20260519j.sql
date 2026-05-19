create table if not exists public.shelves (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create index if not exists shelves_user_name_idx on public.shelves (user_id, name);

alter table public.shelves enable row level security;

drop policy if exists "Users can read their own shelves" on public.shelves;
drop policy if exists "Users can insert their own shelves" on public.shelves;
drop policy if exists "Users can update their own shelves" on public.shelves;
drop policy if exists "Users can delete their own shelves" on public.shelves;

create policy "Users can read their own shelves"
  on public.shelves for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can insert their own shelves"
  on public.shelves for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "Users can update their own shelves"
  on public.shelves for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their own shelves"
  on public.shelves for delete
  to authenticated
  using (auth.uid() = user_id);
