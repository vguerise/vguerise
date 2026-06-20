const jwt = require('jsonwebtoken');

module.exports = async function handler(req, res) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();

  if (!token) return res.status(401).json({ valid: false });

  try {
    jwt.verify(token, process.env.JWT_SECRET);
    return res.status(200).json({ valid: true });
  } catch {
    return res.status(401).json({ valid: false });
  }
};
