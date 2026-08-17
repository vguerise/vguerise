// Cloudflare Worker — cobrança dinâmica (Mercado Pago) + controle real de vagas do Jantar Olfativo
//
// Variáveis de ambiente (CF Dashboard → Worker → Settings → Variables):
//   MP_ACCESS_TOKEN — Access Token de produção do Mercado Pago (secret)
// KV Namespace:
//   VAGAS_KV — chave "vagas:<cidade>" = vagas restantes; chave "processado:<payment_id>" = idempotência do webhook

const ALLOWED_ORIGIN = 'https://vguerise.com.br';
const SITE_URL = 'https://vguerise.com.br/jantarolfativo';
const WORKER_URL = 'https://jantar-checkout.jantar-checkout.workers.dev';

const PRECO_POR_VAGA = 1100; // R$ — mesmo valor em todas as cidades
const QUANTIDADE_MAXIMA = 6; // máximo por compra

const CIDADES = {
  'Brasília': { data: '24/08' },
  'Curitiba': { data: '27/08' },
};

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : 'null',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

async function getVagas(env, cidade) {
  const val = await env.VAGAS_KV.get(`vagas:${cidade}`);
  return val === null ? 0 : parseInt(val, 10);
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') ?? '';

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(req.url);
    const { pathname } = url;

    // GET /vagas — vagas restantes por cidade
    if (pathname === '/vagas' && req.method === 'GET') {
      const resultado = {};
      for (const cidade of Object.keys(CIDADES)) {
        resultado[cidade] = await getVagas(env, cidade);
      }
      return json(resultado, 200, origin);
    }

    // POST /checkout — cria uma preferência de pagamento no Mercado Pago
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

      const vagasRestantes = await getVagas(env, cidade);
      if (qtd > vagasRestantes) {
        return json({
          error: vagasRestantes === 0
            ? `Vagas esgotadas para ${cidade}.`
            : `Restam apenas ${vagasRestantes} vaga(s) para ${cidade}.`,
        }, 409, origin);
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
        notification_url: `${WORKER_URL}/webhook`,
        statement_descriptor: 'JANTAROLFATIVO',
        external_reference: `${cidade}|${qtd}`,
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

    // POST /webhook — Mercado Pago avisa aqui quando o status de um pagamento muda.
    // Só desconta vagas quando o pagamento está de fato aprovado (nunca confia no clique de compra).
    if (pathname === '/webhook' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const paymentId = url.searchParams.get('data.id') || body?.data?.id;

      if (!paymentId) return new Response('ok', { status: 200 });

      const jaProcessado = await env.VAGAS_KV.get(`processado:${paymentId}`);
      if (jaProcessado) return new Response('ok', { status: 200 });

      const payResp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: { 'Authorization': `Bearer ${env.MP_ACCESS_TOKEN}` },
      });
      if (!payResp.ok) return new Response('ok', { status: 200 });

      const payment = await payResp.json();

      if (payment.status === 'approved') {
        const [cidade, qtdStr] = String(payment.external_reference || '').split('|');
        const qtd = parseInt(qtdStr, 10) || 0;

        if (CIDADES[cidade] && qtd > 0) {
          const atual = await getVagas(env, cidade);
          const novo = Math.max(0, atual - qtd);
          await env.VAGAS_KV.put(`vagas:${cidade}`, String(novo));
        }
        await env.VAGAS_KV.put(`processado:${paymentId}`, '1', { expirationTtl: 60 * 60 * 24 * 30 });
      }

      return new Response('ok', { status: 200 });
    }

    return new Response('Not found', { status: 404 });
  },
};
