create table if not exists public.books (
  isbn text primary key,
  title text not null default '',
  authors text not null default '',
  publisher text not null default '',
  source text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.inventory (
  user_id uuid not null references auth.users(id) on delete cascade,
  isbn text not null references public.books(isbn) on delete cascade,
  count integer not null default 0 check (count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, isbn)
);

create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  isbn text not null references public.books(isbn) on delete cascade,
  title text not null default '',
  delta integer not null,
  reason text not null default '扫码',
  created_at timestamptz not null default now()
);

create table if not exists public.lookup_cache (
  isbn text primary key,
  title text not null default '',
  authors text not null default '',
  publisher text not null default '',
  source text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists public.shelves (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create index if not exists inventory_user_updated_idx on public.inventory (user_id, updated_at desc);
create index if not exists stock_movements_user_created_idx on public.stock_movements (user_id, created_at desc);
create index if not exists shelves_user_name_idx on public.shelves (user_id, name);

alter table public.books add column if not exists cover_url text not null default '';
alter table public.books add column if not exists price text not null default '';
alter table public.books add column if not exists published_date text not null default '';
alter table public.books add column if not exists edition text not null default '';
alter table public.inventory add column if not exists category text not null default '';
alter table public.inventory add column if not exists shelf text not null default '';
alter table public.inventory add column if not exists location text not null default '';
alter table public.inventory add column if not exists note text not null default '';
alter table public.lookup_cache add column if not exists cover_url text not null default '';
alter table public.lookup_cache add column if not exists price text not null default '';
alter table public.lookup_cache add column if not exists published_date text not null default '';
alter table public.lookup_cache add column if not exists edition text not null default '';

alter table public.books enable row level security;
alter table public.inventory enable row level security;
alter table public.stock_movements enable row level security;
alter table public.lookup_cache enable row level security;
alter table public.shelves enable row level security;

drop policy if exists "Books are readable by signed-in users" on public.books;
drop policy if exists "Signed-in users can insert books" on public.books;
drop policy if exists "Signed-in users can update books" on public.books;
drop policy if exists "Users can read their own inventory" on public.inventory;
drop policy if exists "Users can insert their own inventory" on public.inventory;
drop policy if exists "Users can update their own inventory" on public.inventory;
drop policy if exists "Users can delete their own inventory" on public.inventory;
drop policy if exists "Users can read their own stock movements" on public.stock_movements;
drop policy if exists "Users can insert their own stock movements" on public.stock_movements;
drop policy if exists "Lookup cache is readable by signed-in users" on public.lookup_cache;
drop policy if exists "Signed-in users can write lookup cache" on public.lookup_cache;
drop policy if exists "Signed-in users can update lookup cache" on public.lookup_cache;
drop policy if exists "Users can read their own shelves" on public.shelves;
drop policy if exists "Users can insert their own shelves" on public.shelves;
drop policy if exists "Users can update their own shelves" on public.shelves;
drop policy if exists "Users can delete their own shelves" on public.shelves;

create policy "Books are readable by signed-in users"
  on public.books for select
  to authenticated
  using (true);

create policy "Signed-in users can insert books"
  on public.books for insert
  to authenticated
  with check (true);

create policy "Signed-in users can update books"
  on public.books for update
  to authenticated
  using (true)
  with check (true);

create policy "Users can read their own inventory"
  on public.inventory for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can insert their own inventory"
  on public.inventory for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "Users can update their own inventory"
  on public.inventory for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their own inventory"
  on public.inventory for delete
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can read their own stock movements"
  on public.stock_movements for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can insert their own stock movements"
  on public.stock_movements for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "Lookup cache is readable by signed-in users"
  on public.lookup_cache for select
  to authenticated
  using (true);

create policy "Signed-in users can write lookup cache"
  on public.lookup_cache for insert
  to authenticated
  with check (true);

create policy "Signed-in users can update lookup cache"
  on public.lookup_cache for update
  to authenticated
  using (true)
  with check (true);

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
