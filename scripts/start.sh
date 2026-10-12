#!/usr/bin/env sh
# Avvia llmpod con Docker Compose. Uso: scripts/start.sh [--no-openwebui]
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LLMPOD_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
. "$SCRIPT_DIR/lib.sh"
llmpod_env

COMPOSE_PROFILES=openwebui
[ "${1:-}" = "--no-openwebui" ] && COMPOSE_PROFILES=""
export COMPOSE_PROFILES
LLMPOD_UI_TOKEN="$(llmpod_random 24)"
export LLMPOD_UI_TOKEN
PORT="${LLMPOD_UI_PORT:-7860}"

# Prima configurazione: manca la chiave Runpod o la configurazione (init interrotto).
NEEDS_INIT=0
if ! grep -q '^RUNPOD_API_KEY=.' "$LLMPOD_ENV_FILE" || [ ! -f "$LLMPOD_CONFIG_DIR/config.json" ]; then NEEDS_INIT=1; fi
if [ "$NEEDS_INIT" = 1 ] && [ ! -t 0 ]; then
  echo "Prima configurazione: esegui lo script da un terminale interattivo" >&2
  exit 1
fi

llmpod_compose build llmpod
if [ "$NEEDS_INIT" = 1 ]; then
  echo "Prima configurazione di llmpod…"
  llmpod_compose run --rm -it llmpod init
fi
echo "Avvio dei servizi (Open WebUI al primo avvio può impiegare alcuni minuti)…"
if llmpod_compose up --help 2>&1 | grep -q -e '--wait-timeout'; then
  llmpod_compose up -d --wait --wait-timeout 120 || echo "⚠ Non tutti i servizi sono ancora pronti (Open WebUI al primo avvio può impiegare alcuni minuti): se serve, controlla con 'bin/llmpod docker-logs'" >&2
else
  llmpod_compose up -d
fi

i=0
until llmpod_compose exec -T llmpod node -e "fetch('http://127.0.0.1:$PORT/api/health',{headers:{host:'127.0.0.1:$PORT'}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then echo "llmpod non risponde: controlla con 'bin/llmpod docker-logs'" >&2; exit 1; fi
  sleep 1
done

URL="http://127.0.0.1:$PORT/?t=$LLMPOD_UI_TOKEN"
echo "Interfaccia llmpod: $URL"
[ -n "$COMPOSE_PROFILES" ] && echo "Open WebUI: http://127.0.0.1:$LLMPOD_OPENWEBUI_PORT (il primo account che crei diventa amministratore)"
echo "Diagnosi: bin/llmpod docker-logs. Per rientrare nell'interfaccia rilancia questo script (il link con il token cambia a ogni avvio)."
case "$(uname -s)" in
  Darwin) open "$URL" >/dev/null 2>&1 || true ;;
  *) command -v xdg-open >/dev/null 2>&1 && xdg-open "$URL" >/dev/null 2>&1 || true ;;
esac
