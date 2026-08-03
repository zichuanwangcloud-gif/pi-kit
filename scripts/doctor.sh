#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
failed=0

check_command() {
  local command=$1
  local required=${2:-optional}
  if command -v "$command" >/dev/null 2>&1; then
    printf '✓ %-12s %s\n' "$command" "$(command -v "$command")"
  elif [[ "$required" == "required" ]]; then
    printf '✗ %-12s missing (required)\n' "$command"
    failed=1
  else
    printf '○ %-12s missing (optional workflow dependency)\n' "$command"
  fi
}

for command in node git pi; do check_command "$command" required; done
for command in gh jq rg; do check_command "$command" optional; done

printf '\nPackage: %s\n' "$ROOT"
node "$ROOT/tests/package-structure.mjs" || failed=1

printf '\nOptional credentials (presence only):\n'
if [[ -s "$HOME/.config/pi/linear-api-key" ]]; then
  mode=$(stat -c '%a' "$HOME/.config/pi/linear-api-key" 2>/dev/null || stat -f '%Lp' "$HOME/.config/pi/linear-api-key")
  printf '✓ Linear API key configured (mode %s)\n' "$mode"
  [[ "$mode" == "600" ]] || { echo '  Warning: recommended mode is 600'; failed=1; }
else
  echo '○ Linear API key not configured (only required for linear-to-pr)'
fi

if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then
    echo '✓ gh authenticated'
  else
    echo '○ gh not authenticated (only required for GitHub PR workflows)'
  fi
fi

exit "$failed"
