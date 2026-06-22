const { normalizeQuery } = require('../_lib/normalize');
const { searchNeeche } = require('../_lib/neeche');
const { searchNuvemshop, searchMellalta } = require('../_lib/nuvemshop');
const { saveCache } = require('../_lib/cache');
const { getDb } = require('../_lib/db');
const { getPerfumeInfo } = require('../_lib/perfume_info');
const { CURATED } = require('../_lib/curated');

function verifyCronSecret(req) {
  const secret = req.headers['x-cron-secret'];
  return !!(process.env.CRON_SECRET && secret === process.env.CRON_SECRET);
}

async function refreshOne(query, existingSlugs) {
  const { slug, display_name } = await normalizeQuery(query, existingSlugs);

  const [r0, r1, r2, r3, r4, r5] = await Promise.allSettled([
    searchNeeche(slug),
    searchNuvemshop('the_gregs', slug),
    searchNuvemshop('pequi', slug),
    searchNuvemshop('king_of_parfums', slug),
    searchNuvemshop('rivoli', slug),
    searchMellalta(slug),
  ]);

  const results = [r0, r1, r2, r3, r4, r5]
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    .flatMap(r => Array.isArray(r.value) ? r.value : [r.value]);

  await saveCache(slug, display_name, results);

  try {
    await getPerfumeInfo(slug, display_name);
  } catch (e) {
    console.warn('[cron/refresh] getPerfumeInfo falhou para', slug, e?.message);
  }

  return { slug, display_name, stores_found: results.length };
}

module.exports = async function handler(req, res) {
  if (!verifyCronSecret(req)) return res.status(401).json({ error: 'Unauthorized' });

  const query = req.query.q || (req.body && req.body.query);

  if (!query) {
    // Retorna TODOS os perfumes com cache existente + curados (seed)
    // O GitHub Actions itera sobre essa lista e atualiza cada um
    try {
      const db = getDb();
      const { data: cacheRows } = await db.from('price_cache').select('display_name');
      const cached = (cacheRows || []).map(r => r.display_name).filter(Boolean);
      const allQueries = [...new Set([...CURATED, ...cached])];
      return res.status(200).json({ queries: allQueries, total: allQueries.length });
    } catch (err) {
      // Fallback para lista curada se o banco falhar
      return res.status(200).json({ queries: CURATED, total: CURATED.length });
    }
  }

  try {
    const db = getDb();
    const { data: rows } = await db.from('price_cache').select('product_slug, display_name');
    const result = await refreshOne(String(query).trim(), rows || []);
    console.log('[cron/refresh] ok:', result.slug, '(' + result.stores_found + ' lojas)');
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[cron/refresh] erro:', query, err?.message);
    return res.status(500).json({ ok: false, query, error: err?.message });
  }
};