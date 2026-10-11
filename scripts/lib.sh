# Funzioni comuni degli script llmpod (POSIX sh). Includere con: . "$(dirname "$0")/lib.sh"

llmpod_random() {
  # $1 = byte; stampa una stringa esadecimale casuale
  od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'
}

llmpod_env() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker non trovato: installa Docker Desktop o Docker Engine" >&2
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "Docker non è in esecuzione: avvialo e riprova" >&2
    exit 1
  fi
  export LLMPOD_CONFIG_DIR="${LLMPOD_CONFIG_DIR:-$HOME/.config/llmpod}"
  export ZCODE_DIR="${ZCODE_DIR:-$HOME/.zcode/v2}"
  export PI_DIR="${PI_DIR:-$HOME/.pi/agent}"
  mkdir -p "$LLMPOD_CONFIG_DIR" "$ZCODE_DIR" "$PI_DIR"
  chmod 700 "$LLMPOD_CONFIG_DIR"
  LLMPOD_ENV_FILE="$LLMPOD_CONFIG_DIR/.env"
  if [ ! -f "$LLMPOD_ENV_FILE" ]; then (umask 077 && : > "$LLMPOD_ENV_FILE"); fi
  if ! grep -q '^LLMPOD_OPENWEBUI_KEY=' "$LLMPOD_ENV_FILE"; then
    (umask 077 && printf 'LLMPOD_OPENWEBUI_KEY=%s\n' "$(llmpod_random 32)" >> "$LLMPOD_ENV_FILE")
  fi
  chmod 600 "$LLMPOD_ENV_FILE"
  LLMPOD_OPENWEBUI_KEY="$(grep '^LLMPOD_OPENWEBUI_KEY=' "$LLMPOD_ENV_FILE" | head -n 1 | cut -d= -f2-)"
  export LLMPOD_OPENWEBUI_KEY
  LLMPOD_UID="$(id -u)"; LLMPOD_GID="$(id -g)"
  export LLMPOD_UID LLMPOD_GID
}
