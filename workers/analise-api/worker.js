// Cloudflare Worker — backend seguro para vguerise.com.br/analise
//
// Variáveis de ambiente (CF Dashboard → Worker → Settings → Variables):
//   APP_EMAIL          — e-mail de login
//   APP_PASSWORD       — senha de login
//   ANTHROPIC_API_KEY  — chave da API Anthropic
//   TOKEN_SECRET       — string aleatória para assinar tokens (qualquer texto longo)

const ALLOWED_ORIGIN = 'https://vguerise.com.br';

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const buf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function makeToken(secret) {
  const ts = Date.now().toString();
  const sig = await hmac(secret, ts);
  return btoa(`${ts}.${sig}`);
}

async function verifyToken(token, secret) {
  try {
    const decoded = atob(token);
    const dot = decoded.lastIndexOf('.');
    const ts = decoded.slice(0, dot);
    const sig = decoded.slice(dot + 1);
    if (Date.now() - parseInt(ts) > 86_400_000) return false; // expira em 24h
    const expected = await hmac(secret, ts);
    if (sig.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  } catch { return false; }
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') ?? '';

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const { pathname } = new URL(req.url);

    // POST /auth — valida credenciais, retorna token de sessão
    if (pathname === '/auth' && req.method === 'POST') {
      const { email, password } = await req.json().catch(() => ({}));
      if (email === env.APP_EMAIL && password === env.APP_PASSWORD) {
        return json({ token: await makeToken(env.TOKEN_SECRET) }, 200, origin);
      }
      return json({ error: 'E-mail ou senha incorretos.' }, 401, origin);
    }

    // POST /claude — valida token, faz proxy para a API Anthropic
    if (pathname === '/claude' && req.method === 'POST') {
      const auth = req.headers.get('Authorization') ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token || !(await verifyToken(token, env.TOKEN_SECRET))) {
        return json({ error: 'Sessão inválida ou expirada.' }, 401, origin);
      }

      const body = await req.json();
      const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });
      const data = await upstream.json();
      return json(data, upstream.status, origin);
    }

    return new Response('Not found', { status: 404 });
  },
};
