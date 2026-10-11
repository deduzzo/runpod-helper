#!/usr/bin/env sh
# Prova del container: salute, Host estraneo, API senza token, proxy con e senza chiave. Non usa credenziali reali.
set -eu
cd "$(dirname "$0")/.."
TMP="$(mktemp -d)"
mkdir -p "$TMP/config" "$TMP/zcode" "$TMP/pi"
chmod 700 "$TMP/config"
NAME="llmpod-smoke-$$"
cleanup() {
  rc=$?
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$TMP"
  # L'ultima riga dell'output dice chiaramente che la prova è fallita.
  if [ "$rc" -ne 0 ]; then echo "✗ smoke test fallito" >&2; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
# Stato HTTP del proxy (porta 8081, non pubblicata) interrogato dall'interno del container; $1 = valore dell'header Authorization (vuoto = nessuno).
proxy_status() {
  docker exec -e AUTH="$1" "$NAME" node -e "fetch('http://127.0.0.1:8081/v1/models',{headers:process.env.AUTH?{authorization:process.env.AUTH}:{}}).then(r=>{console.log(r.status);process.exit(0)}).catch(()=>{console.log('errore');process.exit(1)})"
}
docker build -q -t llmpod:local . >/dev/null
docker run -d --name "$NAME" --user "$(id -u):$(id -g)" -p 127.0.0.1:7999:7999 -e LLMPOD_UI_PORT=7999 -e LLMPOD_UI_TOKEN=token-smoke-1234567890 \
  -v "$TMP/config:/config" -v "$TMP/zcode:/zcode" -v "$TMP/pi:/pi" llmpod:local >/dev/null
i=0
until [ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: 127.0.0.1:7999' http://127.0.0.1:7999/api/health)" = "200" ]; do
  i=$((i + 1)); [ "$i" -gt 30 ] && { docker logs "$NAME"; echo "✗ il container non risponde" >&2; exit 1; }; sleep 1
done
echo "✓ salute 200"
[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example.com' http://127.0.0.1:7999/api/health)" = "403" ] && echo "✓ Host estraneo 403" || { echo "✗ Host estraneo non rifiutato" >&2; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7999/api/session)" = "401" ] && echo "✓ API senza token 401" || { echo "✗ API accessibile senza token" >&2; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Cookie: llmpod_session=token-smoke-1234567890' http://127.0.0.1:7999/api/session)" = "200" ] && echo "✓ API con token 200" || { echo "✗ token non accettato" >&2; exit 1; }
[ -f "$TMP/config/.env" ] && [ "$(stat -c '%a' "$TMP/config/.env" 2>/dev/null || stat -f '%Lp' "$TMP/config/.env")" = "600" ] && echo "✓ .env creato con permessi 600" || { echo "✗ permessi di .env" >&2; exit 1; }
# La chiave interna è quella generata dal container nel .env di prova (nessun valore reale).
KEY_SMOKE="$(grep '^LLMPOD_OPENWEBUI_KEY=' "$TMP/config/.env" | head -n 1 | cut -d= -f2-)"
[ -n "$KEY_SMOKE" ] || { echo "✗ chiave interna non generata nel .env di prova" >&2; exit 1; }
[ "$(proxy_status "Bearer $KEY_SMOKE")" = "503" ] && echo "✓ proxy con chiave: 503 (nessun Pod attivo)" || { echo "✗ il proxy con chiave non risponde 503" >&2; exit 1; }
[ "$(proxy_status "")" = "401" ] && echo "✓ proxy senza chiave: 401" || { echo "✗ il proxy senza chiave non risponde 401" >&2; exit 1; }
docker run --rm --entrypoint sh llmpod:local -c 'test ! -e /app/.env && test ! -e /app/.git && test ! -e /app/test' && echo "✓ immagine senza .env/.git/test"
