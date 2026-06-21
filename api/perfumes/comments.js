const jwt = require('jsonwebtoken');
const { getDb } = require('../_lib/db');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://vguerise.com.br');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

  const db = getDb();

  if (req.method === 'GET') {
    const slug = (req.query.slug || '').trim();
    if (!slug) return res.status(400).json({ error: 'slug obrigatório' });

    const { data, error } = await db
      .from('perfume_comments')
      .select('id, user_email, comment, created_at')
      .eq('product_slug', slug)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ comments: data || [] });
  }

  if (req.method === 'POST') {
    const { slug, comment } = req.body || {};
    const text = String(comment || '').trim();
    if (!slug || !text) return res.status(400).json({ error: 'slug e comment obrigatórios' });
    if (text.length > 500) return res.status(400).json({ error: 'Máximo 500 caracteres' });

    const { data, error } = await db
      .from('perfume_comments')
      .insert({ product_slug: slug, user_email: payload.sub, comment: text })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  return res.status(405).json({ error: 'Método não permitido' });
};

