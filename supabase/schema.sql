-- ── Users ─────────────────────────────────────────────────────────────────────
create table if not exists users (
  id                     uuid primary key default gen_random_uuid(),
  email                  text unique not null,
  stripe_customer_id     text unique,
  stripe_subscription_id text,
  plan                   text check (plan in ('pro', 'agency')),
  subscription_status    text check (subscription_status in ('active', 'cancelled', 'past_due')),
  created_at             timestamptz default now()
);

alter table users enable row level security;

create policy "Users can view own row"
  on users for select
  using (auth.uid() = id);

create policy "Users can update own row"
  on users for update
  using (auth.uid() = id);

-- ── Sites ─────────────────────────────────────────────────────────────────────
create table if not exists sites (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references users(id) on delete cascade not null,
  url             text not null,
  name            text not null,
  schedule        text default '0 8 * * 1',
  max_pages       int default 100,
  check_external  boolean default true,
  active          boolean default true,
  created_at      timestamptz default now()
);

alter table sites enable row level security;

create policy "Users can view own sites"
  on sites for select
  using (auth.uid() = user_id);

create policy "Users can insert own sites"
  on sites for insert
  with check (auth.uid() = user_id);

create policy "Users can update own sites"
  on sites for update
  using (auth.uid() = user_id);

create policy "Users can delete own sites"
  on sites for delete
  using (auth.uid() = user_id);

-- ── Scans ─────────────────────────────────────────────────────────────────────
create table if not exists scans (
  id                uuid primary key default gen_random_uuid(),
  site_id           uuid references sites(id) on delete cascade not null,
  started_at        timestamptz,
  finished_at       timestamptz,
  pages_crawled     int,
  external_checked  int,
  broken_count      int,
  broken_links      jsonb,
  created_at        timestamptz default now()
);

alter table scans enable row level security;

create policy "Users can view scans for own sites"
  on scans for select
  using (
    exists (
      select 1 from sites
      where sites.id = scans.site_id
      and sites.user_id = auth.uid()
    )
  );

-- ── Indexes ───────────────────────────────────────────────────────────────────
create index if not exists sites_user_id_idx on sites(user_id);
create index if not exists sites_active_idx  on sites(active);
create index if not exists scans_site_id_idx on scans(site_id);
create index if not exists scans_created_idx on scans(created_at desc);
