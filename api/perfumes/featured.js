const jwt = require('jsonwebtoken');
const { getDb } = require('../_lib/db');
const { getProductImage } = require('../_lib/perfume_info');

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
  if (!authGuard(req)) return res.status(401).json({ error: 'Nao autorizado' });

  try {
    const db = getDb();

    const { data: cacheRows, error } = await db
      .from('price_cache')
      .select('product_slug, display_name, results, cached_at')
      .not('results', 'is', null);

    if (error) throw error;
    if (!cacheRows || cacheRows.length === 0) {
      return res.status(200).json({ featured: [], total: 0 });
    }

    const deals = [];
    for (const row of cacheRows) {
      let results;
      try {
        results = Array.isArray(row.results) ? row.results : JSON.parse(row.results || '[]');
      } catch { continue; }

      const withPrice = results.filter(r => r.price_cents > 0);
      if (withPrice.length === 0) continue;

      // Testers excluidos do calculo de desconto — preco de tester nao deve inflar savings_pct
      const regularsWithPrice = withPrice.filter(r => !r.is_tester);
      const priceBase = regularsWithPrice.length > 0 ? regularsWithPrice : withPrice;

      const prices = priceBase.map(r => r.price_cents);
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      const savings_pct = priceBase.length >= 2 ? Math.round((1 - min / max) * 100) : 0;
      const bestResult = priceBase.find(r => r.price_cents === min) || priceBase[0];

      deals.push({
        slug: row.product_slug,
        display_name: row.display_name,
        min_price: min,
        max_price: max,
        savings_pct,
        stores_count: withPrice.length,
        best_store: bestResult?.store_display_name,
        results,
        cached_at: row.cached_at
      });
    }

    deals.sort((a, b) => b.savings_pct - a.savings_pct || a.min_price - b.min_price);

    const top = deals.slice(0, 12);
    if (top.length === 0) return res.status(200).json({ featured: [], total: 0 });

    const slugs = top.map(d => d.slug);
    const { data: details } = await db
      .from('perfume_details')
      .select('product_slug, brand, image_url, description, notes_top, notes_heart, notes_base, accords, gender')
      .in('product_slug', slugs);

    const detailMap = {};
    for (const d of (details || [])) detailMap[d.product_slug] = d;

    const featured = top.map(deal => ({
      ...deal,
      ...(detailMap[deal.slug] || {})
    }));

    const noImage = featured.filter(f => !f.image_url).slice(0, 3);
    if (noImage.length > 0) {
      await Promise.race([
        Promise.allSettled(
          noImage.map(item =>
            getProductImage(item.slug)
              .then(url => {
                if (!url) return;
                item.image_url = url;
                db.from('perfume_details').upsert(
                  { product_slug: item.slug, display_name: item.display_name || item.slug, image_url: url, updated_at: new Date().toISOString() },
                  { onConflict: 'product_slug' }
                ).catch(() => {});
              })
              .catch(() => {})
          )
        ),
        new Promise(resolve => setTimeout(resolve, 5000))
      ]);
    }

    return res.status(200).json({ featured, total: deals.length });
  } catch (err) {
    console.error('[featured] erro:', err?.message, err?.stack);
    return res.status(500).json({ error: 'Erro interno', detail: err?.message });
  }
};