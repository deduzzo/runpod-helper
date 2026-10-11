#!/usr/bin/env sh
# Prova del container: salute, Host estraneo, API senza token. Non usa credenziali reali.
set -eu
cd "$(dirname "$0")/.."
TMP="$(mktemp -d)"
mkdir -p "$TMP/config" "$TMP/zcode" "$TMP/pi"
chmod 700 "$TMP/config"
NAME="llmpod-smoke-$$"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT INT TERM
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
docker run --rm --entrypoint sh llmpod:local -c 'test ! -e /app/.env && test ! -e /app/.git && test ! -e /app/test' && echo "✓ immagine senza .env/.git/test"
