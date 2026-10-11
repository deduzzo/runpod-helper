#!/usr/bin/env sh
# Ferma i container locali di llmpod. I Pod su Runpod non vengono toccati: se ce ne sono di attivi, avvisa.
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LLMPOD_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
. "$SCRIPT_DIR/lib.sh"
llmpod_check_docker
llmpod_dirs

# Avviso sui Pod ancora attivi (a pagamento). Se il controllo non riesce (nessuna chiave, rete, immagine assente) si prosegue.
if [ -f "$LLMPOD_ENV_FILE" ] && grep -q '^RUNPOD_API_KEY=.' "$LLMPOD_ENV_FILE" && docker image inspect llmpod:local >/dev/null 2>&1; then
  if STATUS="$(llmpod_compose run --rm -T llmpod status --json 2>/dev/null)"; then
    printf '%s\n' "$STATUS" | awk -F'"' '/^ *"profile": /{p=$4} /^ *"podId": /{print p, $4}' | while read -r PROFILE POD; do
      if [ -n "$POD" ]; then
        echo "⚠ Il Pod $POD del profilo $PROFILE resta acceso e a pagamento: fermalo con bin/llmpod down $PROFILE" >&2
      fi
    done
  fi
fi

llmpod_compose --profile openwebui down
echo "llmpod fermato (configurazione e dati di Open WebUI conservati). I Pod su Runpod non vengono fermati: si fermano con bin/llmpod down o da soli dopo l'inattività"
