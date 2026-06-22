const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('./db');

const claude = new Anthropic();

const CACHE_TTL_DAYS = 30;

// Extrai URL de imagem do JSON-LD de uma página de produto
function extractImageFromLd(html) {
  const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const b of blocks) {
    const content = b.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
    try {
      const data = JSON.parse(content);
      if (data['@type'] === 'Product' && data.image) {
        const img = Array.isArray(data.image) ? data.image[0] : data.image;
        const url = typeof img === 'string' ? img : img?.url || img?.['@id'];
        if (url && url.startsWith('http')) return url;
      }
    } catch {}
  }
  // Helper: extrai content de meta com property — suporta qualquer ordem de atributos
  function metaProp(prop) {
    let m = html.match(new RegExp('<meta[^>]+property="' + prop + '"[^>]+content="([^"]+)"', 'i'));
    if (m?.[1]) return m[1];
    m = html.match(new RegExp('<meta[^>]+content="([^"]+)"[^>]+property="' + prop + '"', 'i'));
    return m?.[1] || null;
  }
  return metaProp('og:image:secure_url') || metaProp('og:image') || null;
}

// Valida se o HTML da página pertence ao produto esperado (evita imagem errada)
// Checa todos os tokens do slug (>=3 chars) no título da página
function pageMatchesSlug(html, slug) {
  const tokens = slug.split('-').filter(p => p.length >= 3);
  const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '').toLowerCase();
  const ogTitle = (html.match(/property="og:title"[^>]+content="([^"]+)"/i)?.[1]
    || html.match(/content="([^"]+)"[^>]+property="og:title"/i)?.[1] || '').toLowerCase();
  const check = title + ' ' + ogTitle;
  return tokens.every(t => check.includes(t));
}

// Busca imagem do produto nas lojas — prioriza Neeche (VTEX) por ter dados mais confiáveis
async function getProductImage(slug) {
  const db = getDb();
  const { data } = await db.from('price_cache').select('results').eq('product_slug', slug).single();
  if (!data || !data.results) return null;

  const results = Array.isArray(data.results) ? data.results : JSON.parse(data.results || '[]');
  const withUrl = results.filter(r => r.product_url);

  // Neeche primeiro (imagens mais confiáveis), depois as outras lojas
  const sorted = [
    ...withUrl.filter(r => r.store === 'neeche'),
    ...withUrl.filter(r => r.store !== 'neeche'),
  ];

  for (const r of sorted) {
    try {
      const resp = await fetch(r.product_url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
        signal: AbortSignal.timeout(7000)
      });
      if (!resp.ok) continue;
      const html = await resp.text();
      if (!pageMatchesSlug(html, slug)) continue; // rejeita página de produto errado
      const imgUrl = extractImageFromLd(html);
      if (imgUrl) return imgUrl;
    } catch {}
  }
  return null;
}

// Gera dados do perfume via Claude (descrição, notas, acordes)
async function generatePerfumeInfo(displayName) {
  const msg = await claude.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: `Você é especialista em perfumaria. Dado o perfume "${displayName}", retorne APENAS um JSON sem texto adicional:

{
  "brand": "Xerjoff",
  "description": "2-3 frases descrevendo o perfume, seu caráter e ocasião ideal",
  "notes_top": ["Limão", "Bergamota"],
  "notes_heart": ["Lavanda", "Gerânio"],
  "notes_base": ["Âmbar", "Sândalo", "Musgo de Carvalho"],
  "accords": ["Aromático", "Amadeirado", "Floral"],
  "gender": "masculino"
}

Regras:
- notes_top: 2-4 notas de topo
- notes_heart: 2-4 notas de coração
- notes_base: 2-4 notas de fundo
- accords: 3-5 famílias olfativas principais (ex: Amadeirado, Floral, Oriental, Cítrico, Aquático, Especiado, Fougère, Gourmand)
- gender: "masculino", "feminino" ou "unissex"
- Se não souber o perfume com certeza, use description: "Perfume de nicho de alta qualidade" e notes/accords genéricos mas plausíveis
- Nomes das notas em português brasileiro`
    }]
  });

  const raw = (msg.content[0].text || '').match(/\{[\s\S]*\}/);
  if (!raw) throw new Error('Claude não retornou JSON válido');
  return JSON.parse(raw[0]);
}

// Busca dados do perfume: do cache ou gera novo
async function getPerfumeInfo(slug, displayName) {
  const db = getDb();

  // Checar cache
  const { data: cached } = await db
    .from('perfume_details')
    .select('*')
    .eq('product_slug', slug)
    .single();

  if (cached && cached.notes_top && cached.notes_top.length > 0) {
    const age = (Date.now() - new Date(cached.updated_at).getTime()) / (1000 * 60 * 60 * 24);
    if (age < CACHE_TTL_DAYS) {
      // Dados ok — mas se imagem estiver faltando tenta buscar sem chamar Claude
      if (!cached.image_url) {
        const imageUrl = await getProductImage(slug).catch(() => null);
        if (imageUrl) {
          await db.from('perfume_details').update({ image_url: imageUrl }).eq('product_slug', slug);
          return { ...cached, image_url: imageUrl };
        }
      }
      return cached;
    }
  }

  // Gerar dados via Claude
  const [info, imageUrl] = await Promise.allSettled([
    generatePerfumeInfo(displayName),
    getProductImage(slug)
  ]);

  const perfumeData = info.status === 'fulfilled' ? info.value : {
    brand: displayName.split(' ')[0],
    description: 'Perfume de nicho internacional.',
    notes_top: [], notes_heart: [], notes_base: [], accords: [], gender: 'unissex'
  };

  const row = {
    product_slug: slug,
    display_name: displayName,
    brand: perfumeData.brand,
    image_url: imageUrl.status === 'fulfilled' ? imageUrl.value : null,
    description: perfumeData.description,
    notes_top: perfumeData.notes_top || [],
    notes_heart: perfumeData.notes_heart || [],
    notes_base: perfumeData.notes_base || [],
    accords: perfumeData.accords || [],
    gender: perfumeData.gender || 'unissex',
    updated_at: new Date().toISOString()
  };

  await db.from('perfume_details').upsert(row, { onConflict: 'product_slug' });
  return row;
}

module.exports = { getPerfumeInfo, getProductImage };