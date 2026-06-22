const jwt = require('jsonwebtoken');
const { normalizeQuery } = require('./_lib/normalize');
const { searchNeeche } = require('./_lib/neeche');
const { searchNuvemshop, searchMellalta } = require('./_lib/nuvemshop');
const { getCached, saveCache, logSearch } = require('./_lib/cache');
const { getDb } = require('./_lib/db');

function authGuard(req) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) return false;
  try {
    jwt.verify(token, process.env.JWT_SECRET);
    return true;
  } catch {
    return false;
  }
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://vguerise.com.br');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization');
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!authGuard(req)) return res.status(401).json({ error: 'Nao autorizado' });

  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Parametro q obrigatorio' });

  try {
    const { data: rows } = await getDb().from('price_cache').select('product_slug, display_name');
    const { slug, display_name } = await normalizeQuery(q, rows || []);

    const cached = await getCached(slug);
    if (cached) {
      await logSearch(q, slug, true);
      return res.status(200).json({
        slug,
        display_name: cached.display_name,
        cache_status: 'hit',
        stores_searched: 6,
        results: cached.results
      });
    }

    const [r0, r1, r2, r3, r4, r5] = await Promise.allSettled([
      searchNeeche(slug),
      searchNuvemshop('the_gregs', slug),
      searchNuvemshop('pequi', slug),
      searchNuvemshop('king_of_parfums', slug),
      searchNuvemshop('rivoli', slug),
      searchMellalta(slug)
    ]);

    const results = [r0, r1, r2, r3, r4, r5]
      .filter(r => r.status === 'fulfilled' && r.value !== null)
      .flatMap(r => Array.isArray(r.value) ? r.value : [r.value]);

    await saveCache(slug, display_name, results);
    await logSearch(q, slug, false);

    return res.status(200).json({ slug, display_name, cache_status: 'miss', stores_searched: 6, results });

  } catch (err) {
    console.error('[search] erro:', err?.message || err);
    return res.status(500).json({ error: 'Erro interno', detail: err?.message });
  }
};