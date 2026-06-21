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

create table if not exists perfume_details (
  product_slug text primary key,
  display_name text not null,
  brand text,
  image_url text,
  description text,
  notes_top text[],
  notes_heart text[],
  notes_base text[],
  accords text[],
  gender text,
  updated_at timestamptz default now()
);

create table if not exists perfume_comments (
  id bigserial primary key,
  product_slug text not null,
  user_email text not null,
  comment text not null,
  created_at timestamptz default now()
);

create index if not exists idx_perfume_comments_slug on perfume_comments(product_slug);
