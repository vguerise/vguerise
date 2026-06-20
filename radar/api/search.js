const jwt = require('jsonwebtoken');
const { normalizeQuery } = require('./lib/normalize');
const { searchNeeche } = require('./lib/neeche');
const { searchNuvemshop } = require('./lib/nuvemshop');
const { getCached, saveCache, logSearch } = require('./lib/cache');
const { getDb } = require('./lib/db');

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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!authGuard(req)) return res.status(401).json({ error: 'Não autorizado' });

  const { query } = req.body || {};
  if (!query?.trim()) return res.status(400).json({ error: 'query obrigatória' });

  // 1. slugs existentes para match determinístico (evita chamada ao Claude)
  const { data: rows } = await getDb().from('price_cache').select('product_slug');
  const existingSlugs = (rows || []).map(r => r.product_slug);

  // 2. normalizar termo → slug canônico
  const { slug, display_name } = await normalizeQuery(query.trim(), existingSlugs);

  // 3. checar cache
  const cached = await getCached(slug);
  if (cached) {
    await logSearch(query, slug, true);
    return res.status(200).json({
      display_name: cached.display_name,
      results: cached.results,
      cached_at: cached.cached_at
    });
  }

  // 4. buscar nas 4 lojas em paralelo
  const [r0, r1, r2, r3] = await Promise.allSettled([
    searchNeeche(slug),
    searchNuvemshop('the_gregs', slug),
    searchNuvemshop('pequi', slug),
    searchNuvemshop('king_of_parfums', slug)
  ]);

  const results = [r0, r1, r2, r3]
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value);

  // 5. salvar no cache (parcial é válido: mesmo que nem todas as lojas respondam)
  await saveCache(slug, display_name, results);
  await logSearch(query, slug, false);

  return res.status(200).json({
    display_name,
    results,
    cached_at: new Date().toISOString()
  });
};
