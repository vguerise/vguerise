// Cloudflare Worker — cria cobranças dinâmicas (Mercado Pago) para o Jantar Olfativo
//
// Variáveis de ambiente (CF Dashboard → Worker → Settings → Variables):
//   MP_ACCESS_TOKEN — Access Token de produção do Mercado Pago (secret)

const ALLOWED_ORIGIN = 'https://vguerise.com.br';
const SITE_URL = 'https://vguerise.com.br/jantarolfativo';

const PRECO_POR_VAGA = 1100; // R$ — mesmo valor em todas as cidades
const QUANTIDADE_MAXIMA = 6;

const CIDADES = {
  'Brasília': { data: '24/08' },
  'Curitiba': { data: '27/08' },
};

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
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

    // POST /checkout — cria uma preferência de pagamento no Mercado Pago e devolve o link
    if (pathname === '/checkout' && req.method === 'POST') {
      const { cidade, quantidade } = await req.json().catch(() => ({}));

      const cidadeInfo = CIDADES[cidade];
      const qtd = Number(quantidade);

      if (!cidadeInfo) {
        return json({ error: 'Cidade inválida.' }, 400, origin);
      }
      if (!Number.isInteger(qtd) || qtd < 1 || qtd > QUANTIDADE_MAXIMA) {
        return json({ error: 'Quantidade inválida.' }, 400, origin);
      }

      const preference = {
        items: [{
          title: `Jantar Olfativo — ${cidade} (${cidadeInfo.data})`,
          quantity: qtd,
          unit_price: PRECO_POR_VAGA,
          currency_id: 'BRL',
        }],
        back_urls: {
          success: `${SITE_URL}/obrigado?cidade=${encodeURIComponent(cidade)}`,
          pending: `${SITE_URL}/obrigado?cidade=${encodeURIComponent(cidade)}&status=pending`,
          failure: `${SITE_URL}?erro=pagamento`,
        },
        auto_return: 'approved',
        statement_descriptor: 'JANTAROLFATIVO',
        external_reference: `${cidade}|${qtd}|${Date.now()}`,
      };

      const upstream = await fetch('https://api.mercadopago.com/checkout/preferences', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.MP_ACCESS_TOKEN}`,
        },
        body: JSON.stringify(preference),
      });

      const data = await upstream.json();

      if (!upstream.ok) {
        return json({ error: 'Não foi possível criar o link de pagamento.', detail: data }, 502, origin);
      }

      return json({ init_point: data.init_point }, 200, origin);
    }

    return new Response('Not found', { status: 404 });
  },
};
