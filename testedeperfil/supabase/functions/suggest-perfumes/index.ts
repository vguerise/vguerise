// =====================================================================
// suggest-perfumes — Supabase Edge Function
// Recebe { archetype: "SED", audience: "m" | "f" | "all", level: "ini" | "int" | "col" }
// e devolve um POOL de até 8 perfumes reais, pesquisados na web, com link da fonte.
// O site sorteia 3 desse pool a cada visita.
//
// Deploy:
//   supabase functions deploy suggest-perfumes --no-verify-jwt
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-... ALLOWED_ORIGINS=https://SEU_USUARIO.github.io
//
// Variáveis opcionais: ANTHROPIC_MODEL (padrão claude-sonnet-4-6), CACHE_TTL_DAYS (padrão 7)
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-4-6";
const TTL_MS = Number(Deno.env.get("CACHE_TTL_DAYS") ?? "7") * 86_400_000;
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const LOCK_MS = 150_000;          // evita duas gerações simultâneas da mesma combinação
const FAIL_COOLDOWN_MS = 300_000; // após falha, espera 5 min antes de tentar de novo

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

// O cliente só envia a CHAVE do arquétipo; todo o texto do prompt vem daqui (sem entrada livre = sem injeção).
const ARCH: Record<string, { name: string; traits: string; fams: string[] }> = {
  SOB: { name: "O Soberano", traits: "Poder, status, presença intimidadora", fams: ["Orientais ricos", "Oudhs", "Âmbar", "Especiarias quentes"] },
  ARQ: { name: "O Arquiteto", traits: "Controle, precisão, minimalismo intencional", fams: ["Aromáticos secos", "Fougères", "Chypres estruturados"] },
  NOM: { name: "O Nômade", traits: "Liberdade, movimento, autenticidade", fams: ["Verdes", "Aquáticos", "Cítricos frescos", "Hespérides"] },
  SED: { name: "O Sedutor", traits: "Presença magnética, intimidade, carisma", fams: ["Florais sensuais", "Gourmands", "Musks quentes"] },
  VIS: { name: "O Visionário", traits: "Originalidade, profundidade intelectual, disrupção", fams: ["Nicho experimental", "Fumaças", "Incenso", "Ozônicos incomuns"] },
  GUA: { name: "O Guardião", traits: "Tradição, lealdade, solidez, permanência", fams: ["Madeiras clássicas", "Couro", "Tabaco", "Fougères tradicionais"] },
  ART: { name: "O Artista", traits: "Expressão criativa, emoção, sensibilidade estética", fams: ["Florais únicos", "Especiarias criativas", "Resinas", "Íris"] },
  EST: { name: "O Estrategista", traits: "Adaptabilidade, leitura social, ambição calibrada", fams: ["Aquáticos modernos", "Ozônicos sofisticados", "Frescos elegantes"] },
  SAB: { name: "O Sábio", traits: "Introspecção, cultura, longa maturidade, contemplação", fams: ["Madeiras envelhecidas", "Balsâmicos", "Terrosos", "Musgos"] },
};
const AUDIENCE: Record<string, string> = {
  m: "masculinos",
  f: "femininos",
  all: "masculinos, femininos ou unissex",
};

const SYSTEM = `Você é consultor de perfumaria de Victor Guerise. Você recomenda perfumes reais, disponíveis para compra hoje, para pessoas que fizeram um teste de arquétipo olfativo.
Regras:
- Use a busca na web para confirmar que cada perfume existe e está à venda (de preferência no Brasil). Nunca invente perfume, marca, notas ou URL.
- Só cite notas olfativas ou fatos que apareçam nas páginas encontradas.
- source_url deve ser exatamente uma URL que apareceu nos resultados da busca, preferindo a página do próprio produto (marca ou loja) em vez de listas, blogs ou fóruns.
- Escreva em português do Brasil, falando diretamente com a pessoa (segunda pessoa), com tom sofisticado e conversacional, sem clichês.
- Responda SOMENTE com JSON válido, sem texto antes ou depois e sem crases.`;

// Nível da pessoa (última pergunta do teste). Muda o perfil da seleção pesquisada.
const LEVELS: Record<string, { label: string; mix: string; focus: string }> = {
  ini: {
    label: "iniciante (está começando no mundo dos perfumes)",
    mix: "5 designer e 3 nicho",
    focus: "perfumes versáteis, bem avaliados, fáceis de encontrar e de preço mais acessível; evite escolhas que exijam repertório para serem apreciadas",
  },
  int: {
    label: "intermediário (tem de 3 a 10 perfumes)",
    mix: "3 designer, 3 nicho e 2 exclusivos",
    focus: "equilíbrio entre clássicos reconhecidos e descobertas",
  },
  col: {
    label: "colecionador (conhece bem e coleciona)",
    mix: "1 designer (apenas se for um clássico ou item raro), 4 nicho e 3 exclusivos",
    focus: "escolhas menos óbvias, de perfumaria autoral, que não sejam as mais citadas",
  },
};

function userPrompt(arch: string, aud: string, level: string) {
  const a = ARCH[arch], l = LEVELS[level];
  return `Arquétipo: ${a.name}. Traço central: ${a.traits}. Famílias olfativas do arquétipo: ${a.fams.join(", ")}.
Público: perfumes ${AUDIENCE[aud]}.
Nível da pessoa: ${l.label}. Foco: ${l.focus}.
Sugira exatamente 8 perfumes que combinem com esse arquétipo, na proporção: ${l.mix}. Não repita perfume e não use a mesma marca mais de duas vezes.
Cada perfume precisa da sua própria página de produto como source_url (uma URL diferente para cada perfume).
Tiers: "designer" = marcas de grande distribuição; "nicho" = marcas de nicho estabelecidas; "exclusivo" = ultra nicho ou alta perfumaria de assinatura, mais raros.
Formato:
{"perfumes":[{"brand":"","name":"","concentration":"ex.: Eau de Parfum","tier":"designer|nicho|exclusivo","why":"1 a 2 frases explicando por que combina com o arquétipo","source_url":""}]}`;
}

// ---------------------------------------------------------------- utilitários
function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") ?? "";
  const allow = ALLOWED_ORIGINS.length === 0
    ? "*"
    : (ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  return {
    "Access-Control-Allow-Origin": allow,
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
const norm = (u: string) => u.replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
const clean = (v: unknown, max: number) =>
  typeof v === "string" ? v.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, max) : "";

// Só https, sem localhost e sem IP literal (proteção básica contra SSRF).
function safeHttpsUrl(u: string): URL | null {
  try {
    const x = new URL(u);
    if (x.protocol !== "https:") return null;
    const h = x.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return null;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":")) return null;
    return x;
  } catch {
    return null;
  }
}

function extractJson(text: string): any {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

// ---------------------------------------------------------------- geração
const POOL_SIZE = 8;   // perfumes guardados por combinação; o site sorteia 3 a cada visita

async function callClaude(messages: unknown[], timeoutMs: number) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
      messages,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error("Anthropic " + res.status + " " + (await res.text()).slice(0, 300));
  return await res.json();
}

function tierOf(v: unknown): string | null {
  const s = clean(v, 30).toLowerCase();
  if (s.includes("exclus") || s.includes("ultra")) return "exclusivo";
  if (s.includes("nicho")) return "nicho";
  if (s.includes("design")) return "designer";
  return null;
}

async function generate(arch: string, aud: string, level: string) {
  const deadline = Date.now() + 125_000;   // limite da Edge Function é ~150 s
  let messages: unknown[] = [{ role: "user", content: userPrompt(arch, aud, level) }];
  const seen = new Map<string, string>();   // URLs que realmente apareceram na busca
  let text = "";

  for (let i = 0; i < 3; i++) {
    const left = deadline - Date.now();
    if (left < 20_000) break;
    const data = await callClaude(messages, Math.min(100_000, left));
    for (const block of data.content ?? []) {
      if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        for (const r of block.content) {
          if (r.type === "web_search_result" && r.url) seen.set(norm(r.url), r.url);
        }
      }
    }
    if (data.stop_reason === "pause_turn") {   // a busca web pode pedir continuação
      messages = [...messages, { role: "assistant", content: data.content }];
      continue;
    }
    text = (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    break;
  }

  const parsed = extractJson(text);
  const out: any[] = [];
  const dupes = new Set<string>();
  const usedUrls = new Set<string>();
  for (const p of (parsed?.perfumes ?? []).slice(0, 14)) {
    const src = seen.get(norm(String(p?.source_url ?? "")));   // descarta URL que não veio da busca
    const brand = clean(p?.brand, 60), name = clean(p?.name, 90), why = clean(p?.why, 320);
    const url = src ? safeHttpsUrl(src) : null;
    const id = (brand + "|" + name).toLowerCase();
    if (!url || !brand || !name || !why || dupes.has(id) || usedUrls.has(norm(url.href))) continue;
    dupes.add(id);
    usedUrls.add(norm(url.href));
    out.push({
      brand,
      name,
      concentration: clean(p?.concentration, 40) || null,
      tier: tierOf(p?.tier),
      why,
      source_url: url.href,
      source_domain: url.hostname.replace(/^www\./, ""),
    });
    if (out.length === POOL_SIZE) break;
  }
  if (out.length < 3) throw new Error("menos de 3 perfumes válidos na resposta");

  return { perfumes: out, generated_at: new Date().toISOString() };
}

// ---------------------------------------------------------------- handler
Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ status: "error" }, 405, cors);
  if (!ANTHROPIC_API_KEY) return json({ status: "error", message: "not configured" }, 500, cors);

  let body: any;
  try { body = await req.json(); } catch { return json({ status: "error" }, 400, cors); }
  const arch = String(body?.archetype ?? "");
  const aud = String(body?.audience ?? "");
  const level = String(body?.level ?? "");
  if (!ARCH[arch] || !AUDIENCE[aud] || !LEVELS[level]) return json({ status: "error", message: "invalid" }, 400, cors);

  const key = `${arch}:${aud}:${level}`;   // só existem 81 combinações possíveis (9 x 3 x 3)
  const { data: row } = await sb.from("perfume_cache")
    .select("payload, updated_at, lock_until, failed")
    .eq("cache_key", key).maybeSingle();

  const now = Date.now();
  const hasPayload = !!row?.payload;
  const fresh = hasPayload && row!.updated_at && now - new Date(row!.updated_at).getTime() < TTL_MS;
  if (fresh) return json({ status: "ok", ...row!.payload, cached: true }, 200, cors);

  const stale = () => json({ status: "ok", ...row!.payload, cached: true, stale: true }, 200, cors);
  const busy = () => {
    if (hasPayload) return stale();
    return row?.failed ? json({ status: "error" }, 503, cors) : json({ status: "pending" }, 202, cors);
  };

  // trava: só uma geração por combinação por vez
  if (row?.lock_until && new Date(row.lock_until).getTime() > now) return busy();
  const lockUntil = new Date(now + LOCK_MS).toISOString();
  if (!row) {
    const { error } = await sb.from("perfume_cache").insert({ cache_key: key, lock_until: lockUntil });
    if (error) return json({ status: "pending" }, 202, cors);   // outra requisição criou primeiro
  } else {
    const { data: got } = await sb.from("perfume_cache")
      .update({ lock_until: lockUntil })
      .eq("cache_key", key)
      .or(`lock_until.is.null,lock_until.lt.${new Date(now).toISOString()}`)
      .select("cache_key");
    if (!got?.length) return busy();
  }

  const work = (async () => {
    try {
      const payload = await generate(arch, aud, level);
      await sb.from("perfume_cache").upsert({
        cache_key: key, payload, updated_at: new Date().toISOString(), lock_until: null, failed: false,
      });
      return payload;
    } catch (e) {
      console.error("suggest-perfumes falhou", key, e);
      await sb.from("perfume_cache")
        .update({ lock_until: new Date(Date.now() + FAIL_COOLDOWN_MS).toISOString(), failed: true })
        .eq("cache_key", key);
      throw e;
    }
  })();

  if (hasPayload) {
    // já existe uma versão antiga: responde na hora e renova em segundo plano
    // @ts-ignore EdgeRuntime existe no ambiente do Supabase
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work.catch(() => {}));
    else work.catch(() => {});
    return stale();
  }

  try {
    const payload = await work;
    return json({ status: "ok", ...payload, cached: false }, 200, cors);
  } catch {
    return json({ status: "error" }, 502, cors);
  }
});
