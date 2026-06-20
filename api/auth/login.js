const jwt = require('jsonwebtoken');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.body || {};
  const incoming = (email || '').toLowerCase().trim();
  const allowed = (process.env.ALLOWED_EMAIL || '').toLowerCase().trim();

  if (!incoming || incoming !== allowed) {
    return res.status(401).json({ error: 'Acesso não autorizado.' });
  }

  const token = jwt.sign(
    { sub: incoming },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  return res.status(200).json({ token });
};
