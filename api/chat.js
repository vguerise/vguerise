const Anthropic = require('@anthropic-ai/sdk');
const jwt = require('jsonwebtoken');
const { normalizeQuery } = require('./_lib/normalize');
const { searchNeeche } = require('./_lib/neeche');
const { searchNuvemshop } = require('./_lib/nuvemshop');
const { getCached, saveCache } = require('./_lib/cache');

const claude = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://vguerise.com.br');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}

function authGuard(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return false;
  try { jwt.verify(token, process.env.JWT_SECRET); return true; } catch { return false; }
}

async function runSearch(term) {
  const { slug, display_name } = await normalizeQuery(term, []);
  const cached = await getCached(slug);
  if (cached) return { display_name: cached.display_name, results: cached.results };
  const settled = await Promise.allSettled([
    searchNeeche(slug),
    searchNuvemshop('the_gregs', slug),
    searchNuvemshop('pequi', slug),
    searchNuvemshop('king_of_parfums', slug),
    searchNuvemshop('rivoli', slug),
    searchNuvemshop('mellalta', slug)
  ]);
  const results = settled.filter(r => r.status === 'fulfilled' && r.value !== null).map(r => r.value);
  await saveCache(slug, display_name, results);
  return { display_name, results };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!authGuard(req)) return res.status(401).json({ error: 'Nao autorizado' });

  const { message, history = [], collection = [] } = req.body || {};
  if (!message?.trim()) return res.status(400).json({ error: 'message obrigatoria' });

  const collectionInfo = collection.length
    ? `Perfumes que o usuario ja possui: ${collection.join(', ')}.`
    : 'O usuario nao informou sua colecao ainda.';

  const system = `Voce e o Concierge do Radar de Perfumes Nicho, especialista em perfumaria masculina de nicho brasileira.

${collectionInfo}

Regras de formatacao obrigatorias:
- Sem emojis em nenhuma hipotese
- Sem hifens, tracos ou linhas separadoras decorativas
- Texto limpo e direto, sem asteriscos ou markdown visivel
- Quando listar opcoes, use numeracao simples: "1.", "2.", "3."
- Precos sempre no formato "R$ 1.290,00 na Neeche"
- Maximo 3 paragrafos por resposta, linguagem sofisticada e concisa

Ao recomendar perfumes:
- Escolha 1 a 3 perfumes especificos adequados ao pedido
- Use search_perfume antes de mencionar precos
- Se o usuario ja possui o perfume, mencione isso brevemente
- Fale sempre em portugues brasileiro`;

  const tools = [{
    name: 'search_perfume',
    description: 'Busca precos em tempo real de um perfume em ate 6 lojas de nicho brasileiras.',
    input_schema: {
      type: 'object',
      properties: {
        perfume_name: { type: 'string', description: 'Nome do perfume com marca. Ex: "Xerjoff Naxos", "Nishane Hacivat"' }
      },
      required: ['perfume_name']
    }
  }];

  let messages = [
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message }
  ];

  for (let i = 0; i < 6; i++) {
    const resp = await claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system,
      tools,
      messages
    });

    if (resp.stop_reason === 'end_turn') {
      const reply = resp.content.find(b => b.type === 'text')?.text || '';
      return res.status(200).json({
        reply,
        history: [...history, { role: 'user', content: message }, { role: 'assistant', content: reply }]
      });
    }

    if (resp.stop_reason === 'tool_use') {
      const toolBlocks = resp.content.filter(b => b.type === 'tool_use');
      messages = [...messages, { role: 'assistant', content: resp.content }];
      const toolResults = await Promise.all(toolBlocks.map(async (tb) => {
        try {
          const data = await runSearch(tb.input.perfume_name);
          const available = (data.results || []).filter(r => r.available !== false).sort((a, b) => a.price_cents - b.price_cents);
          return {
            type: 'tool_result',
            tool_use_id: tb.id,
            content: JSON.stringify({
              display_name: data.display_name,
              found: available.length > 0,
              results: available.map(r => ({ store: r.store_display_name, price: `R$ ${(r.price_cents/100).toFixed(2).replace('.',',')}`, url: r.product_url }))
            })
          };
        } catch {
          return { type: 'tool_result', tool_use_id: tb.id, content: '{"found":false}' };
        }
      }));
      messages = [...messages, { role: 'user', content: toolResults }];
    }
  }

  return res.status(200).json({ reply: 'Nao consegui processar sua solicitacao. Tente novamente.', history });
};