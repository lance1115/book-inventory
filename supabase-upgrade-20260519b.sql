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
