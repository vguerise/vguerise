// Tokeniza um string removendo tamanhos (ml) e palavras genericas
function coreTokens(str) {
  return str
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\d+\s*ml\b/g, '')
    .replace(/\b(eau de parfum|eau de toilette|extrait|edp|edt|parfum)\b/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(t => t.length > 1);
}

// Retorna o produto da VTEX que corresponde sem ambiguidade ao termo buscado
function pickBestProduct(products, term, { excludeTesters = false } = {}) {
  const searchCore = coreTokens(term);
  const sizeMatch = term.match(/(\d+)\s*ml/i);
  const searchSize = sizeMatch ? sizeMatch[1] : null;

  let candidates = products.filter(p => {
    const pCore = coreTokens(p.productName);
    return searchCore.every(t => pCore.includes(t));
  });

  if (excludeTesters) {
    candidates = candidates.filter(p => !p.productName.toLowerCase().includes('tester'));
  }

  if (!candidates.length) return null;

  const uniqueNames = new Set(candidates.map(p => coreTokens(p.productName).join(' ')));
  if (uniqueNames.size > 1) return null;

  if (searchSize) {
    const sized = candidates.filter(p => p.productName.includes(searchSize + 'ml') || p.productName.includes(searchSize + ' ml'));
    if (!sized.length) return null;
    return sized[0];
  }

  return candidates[0];
}

async function searchNeeche(term) {
  const url = `https://www.neeche.com.br/api/catalog_system/pub/products/search?ft=${encodeURIComponent(term)}`;

  let products;
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RadarPerfumes/1.0)' },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) return null;
    products = await r.json();
  } catch {
    return null;
  }

  if (!Array.isArray(products) || !products.length) return null;

  function buildResult(p, isTester) {
    const item = p.items?.[0];
    const offer = item?.sellers?.[0]?.commertialOffer;
    if (!offer || offer.Price <= 0) return null;
    const result = {
      store: 'neeche',
      store_display_name: 'Neeche',
      product_name: p.productName,
      price_cents: Math.round(offer.Price * 100),
      currency: 'BRL',
      product_url: `https://www.neeche.com.br/${p.linkText}/p`,
      available: (offer.AvailableQuantity || 0) > 0,
      extraction_confidence: 100
    };
    // Imagem direto do response VTEX — nao precisa raspar pagina
    const rawImageUrl = item?.images?.[0]?.imageUrl || null;
    if (rawImageUrl) result.image_url = rawImageUrl;
    if (isTester) result.is_tester = true;
    return result;
  }

  const regular = pickBestProduct(products, term, { excludeTesters: true });
  const tester = pickBestProduct(products, term + ' tester');

  const out = [];
  const rResult = regular ? buildResult(regular, false) : null;
  const tResult = tester ? buildResult(tester, true) : null;
  if (rResult) out.push(rResult);
  if (tResult) out.push(tResult);

  if (out.length === 0) return null;
  if (out.length === 1) return out[0];
  return out;
}

// Retorna os N mais vendidos da Neeche usando a API de catalogo VTEX
async function browseNeecheBestSellers(limit = 60) {
  const url = `https://www.neeche.com.br/api/catalog_system/pub/products/search?O=OrderByTopSaleDESC&_from=0&_to=${limit - 1}`;
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RadarPerfumes/1.0)' },
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) return [];
    const products = await r.json();
    if (!Array.isArray(products)) return [];
    const seen = new Set();
    const names = [];
    for (const p of products) {
      if (!p.productName) continue;
      const key = coreTokens(p.productName).join(' ');
      if (!seen.has(key) && !p.productName.toLowerCase().includes('tester')) {
        seen.add(key);
        names.push(p.productName);
      }
    }
    return names;
  } catch {
    return [];
  }
}

module.exports = { searchNeeche, browseNeecheBestSellers };