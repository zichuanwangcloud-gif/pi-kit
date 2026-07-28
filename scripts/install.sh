#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

if ! command -v pi >/dev/null 2>&1; then
  echo "Error: pi command not found" >&2
  exit 1
fi

pi install "$ROOT"

echo
echo "CloudRouter Pi Kit installed from: $ROOT"
echo "Run /reload in an existing Pi session, then /help installed."
