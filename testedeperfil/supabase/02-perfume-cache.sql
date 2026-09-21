-- =====================================================================
-- Cache automático das sugestões de perfumes (não é uma lista curada)
-- Cole em: Supabase > SQL Editor > New query > Run
--
-- A cada CACHE_TTL_DAYS (padrão 7) a função pesquisa a web de novo e
-- substitui o conteúdo. Existem no máximo 81 linhas (9 arquétipos x 3 públicos x 3 níveis).
-- =====================================================================
create table if not exists public.perfume_cache (
  cache_key   text primary key,          -- ex.: 'SED:f:col' (arquétipo:público:nível)
  payload     jsonb,                     -- { perfumes: [até 8], generated_at }
  updated_at  timestamptz,
  lock_until  timestamptz,               -- evita duas gerações ao mesmo tempo
  failed      boolean not null default false
);

-- Só a Edge Function (service role) lê e escreve. O site NÃO tem acesso direto.
alter table public.perfume_cache enable row level security;
revoke all on public.perfume_cache from anon, authenticated;

-- Para forçar uma nova pesquisa de tudo (ex.: depois de mudar o prompt):
-- update public.perfume_cache set updated_at = null;
