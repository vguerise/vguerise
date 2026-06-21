const Anthropic = require('@anthropic-ai/sdk');

const claude = new Anthropic(); // lê ANTHROPIC_API_KEY automaticamente

function parseJson(text) {
  const match = (text || '').match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Resposta do Claude sem JSON válido');
  return JSON.parse(match[0]);
}

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

// Converte slug em nome legível: "xerjoff-naxos" → "Xerjoff Naxos"
function slugToTitle(slug) {
  const lower = new Set(['de', 'du', 'le', 'la', 'les', 'des', 'el', 'of', 'the', 'and', 'for']);
  return slug.split('-').map((w, i) =>
    (i === 0 || !lower.has(w)) ? w.charAt(0).toUpperCase() + w.slice(1) : w
  ).join(' ');
}

async function normalizeQuery(query, existingRows = []) {
  // Aceita array de slugs (string) ou de objetos {product_slug, display_name}
  const candidate = toSlugTokens(query);
  const hit = existingRows.find(r => {
    const s = typeof r === 'string' ? r : r.product_slug;
    return toSlugTokens(s) === candidate;
  });
  if (hit) {
    const slug = typeof hit === 'string' ? hit : hit.product_slug;
    const existing_name = typeof hit === 'object' ? hit.display_name : null;
    // Usar nome existente se for um título legível (tem maiúsculas ou espaços)
    const display_name = (existing_name && existing_name !== slug && /[A-Z ]/.test(existing_name))
      ? existing_name
      : slugToTitle(slug);
    return { slug, display_name };
  }

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

  return parseJson(msg.content[0].text);
}

module.exports = { normalizeQuery };
