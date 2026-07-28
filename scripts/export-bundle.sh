#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
if [[ ! -d "$ROOT/.git" ]]; then
  echo "Error: initialize and commit the Kit repository first" >&2
  exit 1
fi
output=${1:-"$HOME/pi-kit.bundle"}
git -C "$ROOT" bundle create "$output" --all
printf 'Bundle created: %s\n' "$output"
printf 'Import on another machine:\n  git clone %q ~/git/pi-kit\n' "$output"
echo '  cd ~/git/pi-kit && ./scripts/bootstrap.sh'
