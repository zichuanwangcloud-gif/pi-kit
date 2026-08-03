#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
missing=()
for command in node git pi; do
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

Optional workflow setup:
  1. gh auth login (required only for GitHub PR workflows)
  2. Install rg (recommended for code-tracing skills)
  3. Configure Pi provider/model credentials
  4. Save a Linear API key to ~/.config/pi/linear-api-key (chmod 600)
  5. Optionally set LINEAR_TEAM_KEY for bare issue numbers

Then start Pi and run:
  /reload
  /help installed
EOF
