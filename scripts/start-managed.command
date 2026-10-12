#!/bin/sh
cd "$(dirname "$0")/.." && exec node src/cli/index.js start "$@"
