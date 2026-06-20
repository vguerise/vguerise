create table if not exists price_cache (
  id uuid primary key default gen_random_uuid(),
  product_slug text not null unique,
  display_name text not null,
  results jsonb not null,
  cached_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists idx_price_cache_slug on price_cache(product_slug);
create index if not exists idx_price_cache_expires on price_cache(expires_at);

create table if not exists search_log (
  id uuid primary key default gen_random_uuid(),
  raw_query text not null,
  resolved_slug text,
  cache_hit boolean not null,
  created_at timestamptz not null default now()
);
