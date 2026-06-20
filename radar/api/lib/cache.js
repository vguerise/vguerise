const { getDb } = require('./db');

const TTL_HOURS = 6;

async function getCached(slug) {
  const { data } = await getDb()
    .from('price_cache')
    .select('*')
    .eq('product_slug', slug)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  return data || null;
}

async function saveCache(slug, displayName, newResults) {
  const db = getDb();

  // Se já existe cache, preservar resultados de lojas que falharam agora
  const { data: existing } = await db
    .from('price_cache')
    .select('results')
    .eq('product_slug', slug)
    .maybeSingle();

  let merged = newResults;
  if (existing) {
    const oldByStore = Object.fromEntries(existing.results.map(r => [r.store, r]));
    const newByStore = Object.fromEntries(newResults.map(r => [r.store, r]));
    // lojas novas sobrescrevem, lojas ausentes mantêm o valor anterior
    merged = Object.values({ ...oldByStore, ...newByStore });
  }

  const now = new Date();
  await db.from('price_cache').upsert({
    product_slug: slug,
    display_name: displayName,
    results: merged,
    cached_at: now.toISOString(),
    expires_at: new Date(now.getTime() + TTL_HOURS * 3600 * 1000).toISOString()
  }, { onConflict: 'product_slug' });
}

async function logSearch(rawQuery, resolvedSlug, cacheHit) {
  await getDb().from('search_log').insert({
    raw_query: rawQuery,
    resolved_slug: resolvedSlug,
    cache_hit: cacheHit
  });
}

module.exports = { getCached, saveCache, logSearch };
