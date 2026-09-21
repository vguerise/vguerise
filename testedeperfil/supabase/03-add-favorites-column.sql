-- =====================================================================
-- Adiciona o campo opcional "3 perfumes favoritos hoje", usado para
-- enriquecer o lead e gerar a leitura personalizada (analyze-profile).
-- Cole em: Supabase > SQL Editor > New query > Run
-- =====================================================================
alter table public.quiz_responses
  add column if not exists favorites text check (char_length(favorites) <= 300);
