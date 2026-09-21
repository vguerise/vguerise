#!/usr/bin/env bash
# Aquece o cache das sugestões de perfumes: 9 arquétipos x 3 públicos x 3 níveis = 81 buscas.
# Cada busca leva ~30-90 s e usa a API da Anthropic. Rode uma vez, depois do deploy da função.
#
# Uso:
#   SUPABASE_URL=https://SEU_PROJETO.supabase.co SUPABASE_KEY=SUA_CHAVE_PUBLICA ./scripts/warm-cache.sh
#   (opcional) ONLY_ARCH="SED ART"  -> aquece só esses arquétipos
set -u
: "${SUPABASE_URL:?defina SUPABASE_URL}"
: "${SUPABASE_KEY:?defina SUPABASE_KEY}"

ARCHS="${ONLY_ARCH:-SOB ARQ NOM SED VIS GUA ART EST SAB}"
tmp="$(mktemp)"
ok=0; fail=0; failed=""

for a in $ARCHS; do
  for u in m f all; do
    for l in ini int col; do
      code=$(curl -s -o "$tmp" -w "%{http_code}" --max-time 170 -X POST \
        "${SUPABASE_URL%/}/functions/v1/suggest-perfumes" \
        -H "Content-Type: application/json" -H "apikey: $SUPABASE_KEY" \
        -d "{\"archetype\":\"$a\",\"audience\":\"$u\",\"level\":\"$l\"}")
      status=$(grep -o '"status":"[a-z]*"' "$tmp" | head -1 | cut -d'"' -f4)
      echo "$(date +%H:%M:%S) $a:$u:$l -> HTTP $code ${status:-?}"
      if [ "$status" = "ok" ]; then
        ok=$((ok+1))
      else
        fail=$((fail+1)); failed="$failed $a:$u:$l"
      fi
      sleep 2
    done
  done
done

rm -f "$tmp"
echo "----"
echo "ok: $ok   falhas: $fail"
[ -n "$failed" ] && echo "refazer:$failed"
exit 0
