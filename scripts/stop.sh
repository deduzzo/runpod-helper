#!/usr/bin/env sh
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."
. "$SCRIPT_DIR/lib.sh"
llmpod_check_docker
llmpod_dirs
docker compose --profile openwebui down
echo "llmpod fermato (configurazione e dati di Open WebUI conservati)"
