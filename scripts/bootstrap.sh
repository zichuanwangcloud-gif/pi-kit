#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
missing=()
for command in node git pi gh; do
  command -v "$command" >/dev/null 2>&1 || missing+=("$command")
done
if ((${#missing[@]})); then
  printf 'Missing required commands: %s\n' "${missing[*]}" >&2
  exit 1
fi

mkdir -p "$HOME/.config/pi"
chmod 700 "$HOME/.config/pi"

"$ROOT/scripts/install.sh"

cat <<'EOF'

Bootstrap complete.

Manual credentials still required:
  1. gh auth login
  2. Configure Pi provider/model credentials
  3. Save Linear API key to ~/.config/pi/linear-api-key (chmod 600)

Then start Pi and run:
  /reload
  /help installed
EOF
