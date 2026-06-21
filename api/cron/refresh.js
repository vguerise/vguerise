const { normalizeQuery } = require('../_lib/normalize');
const { searchNeeche } = require('../_lib/neeche');
const { searchNuvemshop } = require('../_lib/nuvemshop');
const { saveCache } = require('../_lib/cache');
const { getDb } = require('../_lib/db');
const { CURATED } = require('../_lib/curated');

function verifyCronSecret(req) {
  const secret = req.headers['x-cron-secret'];
  return !!(process.env.CRON_SECRET && secret === process.env.CRON_SECRET);
}

async function refreshOne(query, existingSlugs) {
  const { slug, display_name } = await normalizeQuery(query, existingSlugs);

  const [r0, r1, r2, r3] = await Promise.allSettled([
    searchNeeche(slug),
    searchNuvemshop('the_gregs', slug),
    searchNuvemshop('pequi', slug),
    searchNuvemshop('king_of_parfums', slug),
  ]);

  const results = [r0, r1, r2, r3]
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value);

  await saveCache(slug, display_name, results);
  return { slug, display_name, stores_found: results.length };
}

module.exports = async function handler(req, res) {
  if (!verifyCronSecret(req)) return res.status(401).json({ error: 'Unauthorized' });

  // GET sem ?q → retorna lista curada para o GitHub Actions ler
  const query = req.query.q || (req.body && req.body.query);
  if (!query) {
    return res.status(200).json({ queries: CURATED, total: CURATED.length });
  }

  try {
    const db = getDb();
    const { data: rows } = await db.from('price_cache').select('product_slug');
    const existingSlugs = (rows || []).map(r => r.product_slug);

    const result = await refreshOne(String(query).trim(), existingSlugs);
    console.log('[cron/refresh] ok:', result.slug, `(${result.stores_found} lojas)`);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[cron/refresh] erro:', query, err?.message);
    return res.status(500).json({ ok: false, query, error: err?.message });
  }
};

