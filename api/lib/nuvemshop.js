const Anthropic = require('@anthropic-ai/sdk');

const claude = new Anthropic();

const STORES = {
  the_gregs: {
    id: 'the_gregs',
    display_name: 'The Gregs Exclusive',
    domain: 'thegregsexclusive.com'
  },
  pequi: {
    id: 'pequi',
    display_name: 'Pequi Perfumes',
    domain: 'pequiperfumes.com.br'
  },
  king_of_parfums: {
    id: 'king_of_parfums',
    display_name: 'The King of Parfums',
    domain: 'www.thekingofparfums.com.br'
  }
};

const CONFIDENCE_MIN = 85;

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  'Accept': 'text/html'
};

async function safeFetch(url) {
  try {
    const r = await fetch(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

// Extrai produtos de blocos JSON-LD <script type="application/ld+json"> com @type Product
function extractJsonLdProducts(html, domain) {
  const products = [];
  const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const b of blocks) {
    const content = b.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
    try {
      const data = JSON.parse(content);
      if (data['@type'] !== 'Product' || !data.name) continue;
      const offers = Array.isArray(data.offers) ? data.offers[0] : data.offers;
      if (!offers || !offers.price) continue;
      const url = offers.url || data.url || data['@id'];
      if (!url || !url.includes(`${domain}/produtos/`)) continue;
      const price_cents = Math.round(parseFloat(offers.price) * 100);
      if (!price_cents || price_cents <= 0 || price_cents > 5000000) continue;
      products.push({ name: data.name, url, price_cents, available: !offers.availability || offers.availability.endsWith('InStock') });
    } catch {}
  }
  return products;
}

// Extrai produtos do LS.variants em páginas de produto individuais do Nuvemshop
function extractLsVariants(html) {
  const m = html.match(/LS\.variants\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) return null;
  try {
    const variants = JSON.parse(m[1]);
    const v = variants[0];
    if (!v) return null;
    return { price_cents: v.price_number_raw, available: v.available !== false };
  } catch {
    return null;
  }
}

// Extrai nome do produto da página individual via JSON-LD ou title tag
function extractProductName(html) {
  const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const b of blocks) {
    const content = b.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
    try {
      const data = JSON.parse(content);
      if (data['@type'] === 'Product' && data.name) return data.name;
    } catch {}
  }
  // Fallback: og:title
  const og = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/);
  return og ? og[1].replace(/\s*[-|].*$/, '').trim() : null;
}

async function matchWithClaude(products, term) {
  const list = products.map(p => `- "${p.name}" → R$${(p.price_cents / 100).toFixed(2)}`).join('\n');
  try {
    const msg = await claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Dado o termo de busca "${term}" e a lista de produtos abaixo, identifique o melhor match e retorne APENAS um JSON sem texto adicional:

{"found":true,"item_name":"nome exato da lista","confidence":95}
ou {"found":false}

Regras:
- O nome base deve corresponder ao termo (ex: "Xerjoff Naxos" bate com "Xerjoff Naxos 100ml" mas não com "Xerjoff Naxos Caspian")
- Se o termo especifica ml, o produto deve ter exatamente esse tamanho
- Prefira produtos sem asterisco (*) — indica versão compartilhável/decant
- Em ambiguidade entre modelos diferentes: found:false
- confidence < 85 se houver qualquer incerteza

Produtos:
${list}`
      }]
    });
    const raw = (msg.content[0].text || '').match(/\{[\s\S]*\}/);
    if (!raw) return null;
    return JSON.parse(raw[0]);
  } catch {
    return null;
  }
}

// Fase 1: Busca na página de marca (SSR com JSON-LD)
async function searchViaBrandPage(store, term) {
  // Tenta 1 palavra depois 2 palavras como slug de marca
  const parts = term.replace(/[^a-z0-9-]/g, '').split('-').filter(Boolean);
  for (let n = 1; n <= Math.min(2, parts.length - 1); n++) {
    const brandSlug = parts.slice(0, n).join('-');
    const html = await safeFetch(`https://${store.domain}/marcas/${brandSlug}/`);
    if (!html) continue;

    const products = extractJsonLdProducts(html, store.domain);
    if (!products.length) continue;

    const result = await matchWithClaude(products, term);
    if (!result || !result.found || (result.confidence ?? 0) < CONFIDENCE_MIN) continue;

    const item = products.find(p => p.name === result.item_name);
    if (!item) continue;

    return {
      store: store.id,
      store_display_name: store.display_name,
      product_name: item.name,
      price_cents: item.price_cents,
      currency: 'BRL',
      product_url: item.url,
      available: item.available,
      extraction_confidence: result.confidence
    };
  }
  return null;
}

// Fase 2: Tentativa direta via slug do produto (para lojas com JSON-LD incompleto nas páginas de marca)
// Usa og:title + LS.variants — NÃO usa extractJsonLdProducts porque em páginas de produto
// os blocos JSON-LD são de produtos relacionados, não do produto principal.
async function searchViaDirectSlug(store, term) {
  const slugCandidates = [
    term,
    `${term}-edp-100ml`,
    `${term}-100ml`,
    `${term}-edp`
  ];

  for (const slug of slugCandidates) {
    const url = `https://${store.domain}/produtos/${slug}/`;
    const html = await safeFetch(url);
    console.log(`[nuvemshop:${store.id}] slug=${slug} html=${html ? html.length : 'null'}`);
    if (!html) continue;

    // Preço via LS.variants (Nuvemshop embeds this in all product pages)
    const variants = extractLsVariants(html);
    console.log(`[nuvemshop:${store.id}] variants=${JSON.stringify(variants)}`);
    if (!variants || !variants.price_cents) continue;

    // Nome via og:title (sempre refere ao produto principal da página)
    const ogTitle = (html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/) || [])[1];
    console.log(`[nuvemshop:${store.id}] ogTitle=${ogTitle}`);
    if (!ogTitle) continue;
    const name = ogTitle.split(/\s*\|\s*/)[0].trim();

    return {
      store: store.id,
      store_display_name: store.display_name,
      product_name: name,
      price_cents: variants.price_cents,
      currency: 'BRL',
      product_url: url,
      available: variants.available,
      extraction_confidence: 88
    };
  }
  return null;
}

async function searchNuvemshop(storeId, term) {
  const store = STORES[storeId];

  const brandResult = await searchViaBrandPage(store, term);
  if (brandResult) { console.log(`[nuvemshop:${storeId}] fase1 ok`); return brandResult; }

  console.log(`[nuvemshop:${storeId}] fase1 nulo, tentando slug direto`);
  const directResult = await searchViaDirectSlug(store, term);
  if (directResult) { console.log(`[nuvemshop:${storeId}] fase2 ok`); return directResult; }

  console.log(`[nuvemshop:${storeId}] ambas fases nulas`);
  return null;
}

module.exports = { searchNuvemshop };
