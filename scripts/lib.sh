# Funzioni comuni degli script llmpod (POSIX sh). Includere con: . "$(dirname "$0")/lib.sh"

llmpod_random() {
  # $1 = byte; stampa una stringa esadecimale casuale
  od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'
}

# Controlla che Docker e Docker Compose v2 siano disponibili e raggiungibili.
llmpod_check_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker non trovato: installa Docker Desktop o Docker Engine" >&2
    exit 1
  fi
  if ! info_out="$(docker info 2>&1)"; then
    case "$info_out" in
      *ermission\ denied*)
        echo "Docker non accessibile: aggiungi l'utente al gruppo docker o usa Docker Desktop" >&2 ;;
      *)
        echo "Docker non è in esecuzione: avvialo e riprova" >&2 ;;
    esac
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    echo "Docker Compose v2 non trovato: aggiorna Docker o installa il plugin compose" >&2
    exit 1
  fi
}

# Imposta le variabili usate da compose.yaml (cartelle e utente) senza creare nulla.
llmpod_dirs() {
  export LLMPOD_CONFIG_DIR="${LLMPOD_CONFIG_DIR:-$HOME/.config/llmpod}"
  export ZCODE_DIR="${ZCODE_DIR:-$HOME/.zcode/v2}"
  export PI_DIR="${PI_DIR:-$HOME/.pi/agent}"
  LLMPOD_ENV_FILE="$LLMPOD_CONFIG_DIR/.env"
  LLMPOD_UID="$(id -u)"; LLMPOD_GID="$(id -g)"
  export LLMPOD_UID LLMPOD_GID
}

llmpod_env() {
  llmpod_check_docker
  llmpod_dirs
  mkdir -p "$LLMPOD_CONFIG_DIR" "$ZCODE_DIR" "$PI_DIR"
  chmod 700 "$LLMPOD_CONFIG_DIR"
  if [ ! -f "$LLMPOD_ENV_FILE" ]; then (umask 077 && : > "$LLMPOD_ENV_FILE"); fi
  if ! grep -q '^LLMPOD_OPENWEBUI_KEY=' "$LLMPOD_ENV_FILE"; then
    # Se l'ultima riga non termina con un a capo, ne aggiunge uno: la riga precedente resta intatta.
    if [ -s "$LLMPOD_ENV_FILE" ] && [ -n "$(tail -c 1 "$LLMPOD_ENV_FILE")" ]; then
      (umask 077 && printf '\n' >> "$LLMPOD_ENV_FILE")
    fi
    (umask 077 && printf 'LLMPOD_OPENWEBUI_KEY=%s\n' "$(llmpod_random 32)" >> "$LLMPOD_ENV_FILE")
  fi
  chmod 600 "$LLMPOD_ENV_FILE"
  LLMPOD_OPENWEBUI_KEY="$(grep '^LLMPOD_OPENWEBUI_KEY=' "$LLMPOD_ENV_FILE" | head -n 1 | cut -d= -f2-)"
  export LLMPOD_OPENWEBUI_KEY
}
