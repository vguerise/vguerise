const jwt = require('jsonwebtoken');
const { getDb } = require('../lib/db');
const { getPerfumeInfo } = require('../lib/perfume_info');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://vguerise.com.br');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization');
}

function authGuard(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return false;
  try { jwt.verify(token, process.env.JWT_SECRET); return true; } catch { return false; }
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!authGuard(req)) return res.status(401).json({ error: 'Não autorizado' });

  try {
    const db = getDb();

    // Buscar todos os registros do cache com múltiplas lojas
    const { data: cacheRows, error } = await db
      .from('price_cache')
      .select('product_slug, display_name, results, updated_at')
      .not('results', 'is', null);

    if (error) throw error;
    if (!cacheRows || cacheRows.length === 0) {
      return res.status(200).json({ featured: [], total: 0 });
    }

    // Calcular melhor oferta por slug (diferença de preço entre lojas)
    const deals = [];
    for (const row of cacheRows) {
      let results;
      try {
        results = Array.isArray(row.results) ? row.results : JSON.parse(row.results || '[]');
      } catch { continue; }

      const available = results.filter(r => r.available !== false && r.price_cents > 0);
      if (available.length < 1) continue; // pelo menos 1 loja com estoque

      const prices = results.filter(r => r.price_cents > 0).map(r => r.price_cents);
      if (prices.length < 2) {
        // Só 1 loja: mostrar mesmo assim, mas sem diferença
        const best = available[0] || results[0];
        deals.push({
          slug: row.product_slug,
          display_name: row.display_name,
          min_price: Math.min(...prices),
          max_price: Math.max(...prices),
          savings_pct: 0,
          stores_count: results.length,
          best_store: best?.store_display_name,
          results
        });
        continue;
      }

      const min = Math.min(...prices);
      const max = Math.max(...prices);
      const savings_pct = Math.round((1 - min / max) * 100);

      const bestResult = results.find(r => r.price_cents === min) || results[0];
      deals.push({
        slug: row.product_slug,
        display_name: row.display_name,
        min_price: min,
        max_price: max,
        savings_pct,
        stores_count: results.length,
        best_store: bestResult?.store_display_name,
        results
      });
    }

    // Ordenar: primeiro os com maior economia, depois por preço mínimo
    deals.sort((a, b) => b.savings_pct - a.savings_pct || a.min_price - b.min_price);

    // Top 12
    const top = deals.slice(0, 12);

    // Enriquecer com dados do perfume (Claude + foto) em paralelo
    const enriched = await Promise.allSettled(
      top.map(async (deal) => {
        const info = await getPerfumeInfo(deal.slug, deal.display_name);
        return { ...deal, ...info };
      })
    );

    const featured = enriched
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);

    return res.status(200).json({ featured, total: deals.length });
  } catch (err) {
    console.error('[featured] erro:', err?.message);
    return res.status(500).json({ error: 'Erro interno', detail: err?.message });
  }
};
