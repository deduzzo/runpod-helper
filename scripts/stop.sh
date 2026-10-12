#!/usr/bin/env sh
# Ferma i container locali di llmpod. I Pod su Runpod non vengono toccati: se ce ne sono (accesi o spenti), avvisa.
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LLMPOD_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
. "$SCRIPT_DIR/lib.sh"
llmpod_check_docker
llmpod_dirs

# Avviso sui Pod ancora esistenti, accesi o spenti (un Pod spento costa ancora il disco). Se il controllo non riesce (nessuna chiave, rete, immagine assente) si prosegue.
if [ -f "$LLMPOD_ENV_FILE" ] && grep -q '^RUNPOD_API_KEY=.' "$LLMPOD_ENV_FILE" && docker image inspect llmpod:local >/dev/null 2>&1; then
  if STATUS="$(llmpod_compose run --rm -T llmpod status --json 2>/dev/null)"; then
    printf '%s\n' "$STATUS" | awk -F'"' '/^ *"profile": /{p=$4} /^ *"podId": /{id=$4} /^ *"state": /{print p, id, $4}' | while read -r PROFILE POD STATE; do
      if [ -n "$POD" ]; then
        if [ "$STATE" = "stopped" ]; then
          echo "⚠ Il Pod $POD del profilo $PROFILE è spento ma costa ancora lo spazio su disco: eliminalo con bin/llmpod down $PROFILE" >&2
        else
          echo "⚠ Il Pod $POD del profilo $PROFILE resta acceso e a pagamento: eliminalo con bin/llmpod down $PROFILE" >&2
        fi
      fi
    done
  fi
fi

llmpod_compose --profile openwebui down
echo "llmpod fermato (configurazione e dati di Open WebUI conservati). I Pod su Runpod non vengono toccati: si eliminano con bin/llmpod down o da soli dopo l'inattività"
