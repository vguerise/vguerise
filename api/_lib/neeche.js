// Tokeniza um string removendo tamanhos (ml) e palavras genéricas
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
    // Todos os tokens do termo devem aparecer no nome do produto
    return searchCore.every(t => pCore.includes(t));
  });

  if (excludeTesters) {
    candidates = candidates.filter(p => !p.productName.toLowerCase().includes('tester'));
  }

  if (!candidates.length) return null;

  // Se há candidatos com nomes-base diferentes (ex: Naxos vs Naxos Caspian),
  // e o termo não desambigua, retorna null em vez de adivinhar
  const uniqueNames = new Set(candidates.map(p => coreTokens(p.productName).join(' ')));
  if (uniqueNames.size > 1) return null;

  // Se o usuário especificou tamanho, filtra pelo tamanho exato
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
    if (isTester) result.is_tester = true;
    return result;
  }

  // Busca versão regular (excluindo testers) e versão tester em paralelo
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

module.exports = { searchNeeche };