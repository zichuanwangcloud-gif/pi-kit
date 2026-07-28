#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
failed=0

check_command() {
  if command -v "$1" >/dev/null 2>&1; then
    printf '✓ %-12s %s\n' "$1" "$(command -v "$1")"
  else
    printf '✗ %-12s missing\n' "$1"
    failed=1
  fi
}

for command in node git pi gh jq rg; do check_command "$command"; done

printf '\nPackage: %s\n' "$ROOT"
node "$ROOT/tests/package-structure.mjs" || failed=1

printf '\nCredentials (presence only):\n'
if [[ -s "$HOME/.config/pi/linear-api-key" ]]; then
  mode=$(stat -c '%a' "$HOME/.config/pi/linear-api-key" 2>/dev/null || stat -f '%Lp' "$HOME/.config/pi/linear-api-key")
  printf '✓ Linear API key configured (mode %s)\n' "$mode"
  [[ "$mode" == "600" ]] || { echo '  Warning: recommended mode is 600'; failed=1; }
else
  echo '○ Linear API key not configured'
fi

if gh auth status >/dev/null 2>&1; then echo '✓ gh authenticated'; else echo '○ gh not authenticated'; fi

exit "$failed"
