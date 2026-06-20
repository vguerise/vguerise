const Anthropic = require('@anthropic-ai/sdk');

const claude = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

const STRIP_WORDS = /\b(eau de parfum|eau de toilette|extrait de parfum|edp|edt|ml)\b/gi;

function toSlugTokens(str) {
  return str
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(STRIP_WORDS, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(Boolean)
    .sort()
    .join('-');
}

async function normalizeQuery(query, existingSlugs = []) {
  // 1. tentativa determinística: compara tokens ordenados contra o cache existente
  const candidate = toSlugTokens(query);
  const hit = existingSlugs.find(s => toSlugTokens(s) === candidate);
  if (hit) return { slug: hit, display_name: hit };

  // 2. fallback: Claude normaliza
  const msg = await claude.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `Você normaliza buscas de perfumes em um slug canônico.

Dado o termo de busca do usuário, retorne APENAS um JSON neste formato, sem texto adicional:
{"slug":"marca-nome-do-perfume-tamanho","display_name":"Marca Nome do Perfume Eau de Parfum TAMANHOml"}

Regras:
- slug em minúsculas, sem acentos, palavras separadas por hífen
- inclua o tamanho em ml se mencionado; se não houver tamanho claro, omita do slug
- normalize variações de marca conhecidas (ex: "ydl"→ysl, "xerjof"→xerjoff)
- não invente informação ausente no termo de busca

Termo de busca: "${query}"`
    }]
  });

  return JSON.parse(msg.content[0].text.trim());
}

module.exports = { normalizeQuery };
