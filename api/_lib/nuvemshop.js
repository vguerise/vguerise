const Anthropic = require('@anthropic-ai/sdk');

const claude = new Anthropic();

const STORES = {
  the_gregs: {
    id: 'the_gregs',
    display_name: 'The Gregs Exclusive',
    domain: 'thegregsexclusive.com',
    // Padrão observado: brand-name-edp-gender-size
    slugHint: 'usa padrão "brand-nome-edp-genero-100ml" ex: xerjoff-naxos-edp-unissex-100ml'
  },
  pequi: {
    id: 'pequi',
    display_name: 'Pequi Perfumes',
    domain: 'pequiperfumes.com.br',
    slugHint: 'usa padrão "brand-nome-edp-size" ex: xerjoff-naxos-edp-100ml ou xerjoff-naxos-edp-100ml1'
  },
  king_of_parfums: {
    id: 'king_of_parfums',
    display_name: 'The King of Parfums',
    domain: 'www.thekingofparfums.com.br',
    slugHint: 'usa padrão curto "brand-nome" ex: xerjoff-naxos ou "brand-nome-edp-100ml"'
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
    const r = await fetch(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

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

// Fase 3: Claude gera slugs específicos para a loja quando as tentativas padrão falham
async function claudeSlugOracle(store, term) {
  try {
    const msg = await claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Você conhece lojas brasileiras de perfumes nicho na plataforma Nuvemshop.

Loja: ${store.display_name} (${store.domain})
Convenção de slug desta loja: ${store.slugHint}

Produto buscado: "${term}"

Gere até 6 candidatos de slug para a URL do produto nesta loja (/produtos/{slug}/).
Priorize variações de gênero (unissex, masculino, feminino) e formato (edp, edt, extrait).
Retorne APENAS um JSON sem texto adicional:

["slug-candidato-1", "slug-candidato-2", "slug-candidato-3"]`
      }]
    });
    const raw = (msg.content[0].text || '').match(/\[[\s\S]*\]/);
    if (!raw) return [];
    const slugs = JSON.parse(raw[0]);
    return Array.isArray(slugs) ? slugs.filter(s => typeof s === 'string' && s.length > 0) : [];
  } catch {
    return [];
  }
}

// Testa um slug de produto na loja e retorna resultado ou null
async function tryProductSlug(store, slug) {
  const url = `https://${store.domain}/produtos/${slug}/`;
  const html = await safeFetch(url);
  if (!html) return null;

  const variants = extractLsVariants(html);
  if (!variants || !variants.price_cents) return null;

  const ogTitle = (html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/) || [])[1];
  if (!ogTitle) return null;
  const name = ogTitle.split(/\s*\|\s*/)[0].trim();

  // Valida que o produto encontrado corresponde ao slug buscado
  // (evita aceitar produto errado quando a loja tem URLs inconsistentes)
  const slugTokens = slug.split('-').filter(t => t.length >= 3);
  if (!slugTokens.every(t => name.toLowerCase().includes(t))) return null;

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

// Fase 1: Página de marca (SSR com JSON-LD)
async function searchViaBrandPage(store, term) {
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

// Fase 2: Testa lista ampla de slugs padrão em paralelo
async function searchViaDirectSlug(store, term) {
  const candidates = [
    term,
    `${term}-edp-100ml`,
    `${term}-100ml`,
    `${term}-edp`,
    // variações de gênero (padrão The Gregs)
    `${term}-edp-unissex-100ml`,
    `${term}-unissex-100ml`,
    `${term}-edp-masculino-100ml`,
    `${term}-masculino-100ml`,
    `${term}-edp-feminino-100ml`,
    `${term}-feminino-100ml`,
    // outros formatos
    `${term}-eau-de-parfum-100ml`,
    `${term}-extrait-de-parfum-100ml`,
    `${term}-extrait-100ml`,
    `${term}-edp-50ml`,
  ];

  const results = await Promise.allSettled(candidates.map(slug => tryProductSlug(store, slug)));
  const hit = results.find(r => r.status === 'fulfilled' && r.value !== null);
  return hit ? hit.value : null;
}

// Fase 3: Claude oracle — gera slugs específicos por loja e testa em paralelo
async function searchViaClaudeOracle(store, term) {
  const slugs = await claudeSlugOracle(store, term);
  if (!slugs.length) return null;

  const results = await Promise.allSettled(slugs.map(slug => tryProductSlug(store, slug)));
  const hit = results.find(r => r.status === 'fulfilled' && r.value !== null);
  return hit ? hit.value : null;
}

// Busca interna: executa as 3 fases para um termo específico
async function searchInStore(store, term) {
  const brandResult = await searchViaBrandPage(store, term);
  if (brandResult) return brandResult;

  const directResult = await searchViaDirectSlug(store, term);
  if (directResult) return directResult;

  const oracleResult = await searchViaClaudeOracle(store, term);
  return oracleResult || null;
}

async function searchNuvemshop(storeId, term) {
  const store = STORES[storeId];

  // Busca versão regular e versão tester em paralelo
  const [regularRes, testerRes] = await Promise.allSettled([
    searchInStore(store, term),
    searchInStore(store, term + '-tester')
  ]);

  const regular = regularRes.status === 'fulfilled' ? regularRes.value : null;
  const testerRaw = testerRes.status === 'fulfilled' ? testerRes.value : null;
  const tester = testerRaw ? { ...testerRaw, is_tester: true } : null;

  if (!regular && !tester) return null;
  if (regular && tester) return [regular, tester];
  return regular || tester;
}

module.exports = { searchNuvemshop };