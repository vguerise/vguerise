const jwt = require('jsonwebtoken');
const { getDb } = require('./_lib/db');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://vguerise.com.br');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}

function getPayload(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return null;
  try { return jwt.verify(token, process.env.JWT_SECRET); } catch { return null; }
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = getPayload(req);
  if (!payload) return res.status(401).json({ error: 'Não autorizado' });

  const email = payload.sub;
  const db = getDb();

  if (req.method === 'GET') {
    const { data, error } = await db
      .from('wishlist')
      .select('product_slug, display_name, created_at')
      .eq('user_email', email)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ items: data || [] });
  }

  if (req.method === 'POST') {
    const { slug, display_name } = req.body || {};
    if (!slug) return res.status(400).json({ error: 'slug obrigatório' });
    const { error } = await db.from('wishlist')
      .upsert({ user_email: email, product_slug: slug, display_name: display_name || slug },
               { onConflict: 'user_email,product_slug', ignoreDuplicates: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const slug = req.query.slug;
    if (!slug) return res.status(400).json({ error: 'slug obrigatório' });
    const { error } = await db.from('wishlist')
      .delete().eq('user_email', email).eq('product_slug', slug);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Método não permitido' });
};
