-- =====================================================================
-- Teste de Arquétipo Olfativo — Victor Guerise
-- Cole este arquivo inteiro em: Supabase > SQL Editor > New query > Run
-- =====================================================================

-- 1) TABELA (uma linha por vez que alguém faz o teste)
create table if not exists public.quiz_responses (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),   -- horário do servidor: serve de prova do consentimento

  -- dados da pessoa
  name                text not null check (char_length(name) between 2 and 100),
  email               text not null check (char_length(email) <= 254
                                           and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  treatment           text not null check (treatment in ('m', 'f')),   -- só a forma gramatical dos nomes (masculino/feminino)

  -- consentimentos (LGPD)
  is_adult            boolean not null check (is_adult),               -- só aceita quem confirmou ter 18+
  consent_processing  boolean not null check (consent_processing),    -- só aceita com consentimento para gerar o resultado
  consent_marketing   boolean not null default false,                  -- opcional
  consent_version     text not null,                                   -- versão dos textos de consentimento exibidos

  -- resultado do teste
  quiz_version        text not null,                                   -- versão de perguntas e pesos usada
  archetype           text not null,                                   -- forma canônica, ex.: 'O Sedutor'
  secondary           text not null,
  scores              jsonb not null check (jsonb_typeof(scores) = 'object'),
  answers             jsonb not null check (jsonb_typeof(answers) = 'array'
                                            and jsonb_array_length(answers) between 1 and 20),
  level               text check (char_length(level) <= 100),          -- resposta da pergunta de nível (não pontua)

  -- origem
  utm                 jsonb,
  page                text check (char_length(page) <= 500)
);

create index if not exists quiz_responses_email_idx   on public.quiz_responses (lower(email));
create index if not exists quiz_responses_created_idx on public.quiz_responses (created_at desc);

-- 2) SEGURANÇA
-- O site usa a chave pública (anon/publishable), que fica visível no código.
-- Por isso: a chave pública só pode INSERIR. Ninguém consegue ler, alterar ou apagar
-- por ela. Você lê os dados pelo painel do Supabase (Table Editor) ou SQL Editor.
alter table public.quiz_responses enable row level security;

revoke all on public.quiz_responses from anon, authenticated;
grant insert on public.quiz_responses to anon;

drop policy if exists "anon pode inserir" on public.quiz_responses;
create policy "anon pode inserir"
  on public.quiz_responses
  for insert
  to anon
  with check (true);

-- (sem política de select/update/delete para anon = bloqueado)

-- =====================================================================
-- CONSULTAS ÚTEIS (rode no SQL Editor quando precisar)
-- =====================================================================

-- Lista de e-mails com consentimento de marketing, respeitando a ESCOLHA MAIS RECENTE de cada pessoa:
-- select name, email, archetype, treatment, created_at
-- from (
--   select distinct on (lower(email)) *
--   from public.quiz_responses
--   order by lower(email), created_at desc
-- ) t
-- where consent_marketing;

-- Quantos por arquétipo:
-- select archetype, count(*) from public.quiz_responses group by 1 order by 2 desc;

-- Pedido de exclusão (LGPD art. 18): apaga todos os registros de um e-mail
-- delete from public.quiz_responses where lower(email) = lower('pessoa@email.com');
