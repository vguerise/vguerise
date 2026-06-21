const jwt = require('jsonwebtoken');
const { getDb } = require('../_lib/db');
const { getPerfumeInfo } = require('../_lib/perfume_info');

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

  const slug = (req.query.slug || '').trim();
  if (!slug) return res.status(400).json({ error: 'slug obrigatório' });

  try {
    const db = getDb();
    const { data: cacheRow } = await db
      .from('price_cache')
      .select('display_name')
      .eq('product_slug', slug)
      .single();

    const displayName = cacheRow?.display_name || slug;
    const info = await getPerfumeInfo(slug, displayName);
    return res.status(200).json(info);
  } catch (err) {
    console.error('[detail] erro:', err?.message);
    return res.status(500).json({ error: 'Erro interno' });
  }
};

