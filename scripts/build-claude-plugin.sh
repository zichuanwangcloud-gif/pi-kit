#!/usr/bin/env bash
# 从 skills/ 重新生成 Claude Code 插件导出（dist/claude-plugin）。
# 版本号自动对齐 package.json；Claude Code 侧通过
#   claude plugin marketplace update pi-kit-marketplace
#   claude plugin install pi-kit@pi-kit-marketplace
# 完成更新。注意：pi 扩展（extensions/）无法导出为 Claude Code 插件。
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
OUT="$ROOT/dist/claude-plugin"

VERSION=$(node -p "require('$ROOT/package.json').version")
if [[ -z "$VERSION" ]]; then
  echo "Error: could not read version from package.json" >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT/.claude-plugin"
cp -R "$ROOT/skills" "$OUT/skills"
find "$OUT/skills" -name ".DS_Store" -delete

cat > "$OUT/.claude-plugin/plugin.json" <<EOF
{
  "name": "pi-kit",
  "version": "$VERSION",
  "description": "Portable engineering skills: PR audit, CI triage, change impact, release readiness, and more.",
  "keywords": [
    "agent-skills",
    "engineering-workflows",
    "pull-request-audit",
    "ci-triage",
    "code-review",
    "change-impact",
    "release-readiness",
    "incident-response",
    "linear"
  ],
  "license": "UNLICENSED"
}
EOF

cat > "$OUT/.claude-plugin/marketplace.json" <<EOF
{
  "name": "pi-kit-marketplace",
  "owner": {
    "name": "Pi Kit"
  },
  "description": "Portable engineering skills: PR audit, CI triage, change impact, release readiness, and more.",
  "plugins": [
    {
      "name": "pi-kit",
      "source": "./",
      "description": "Portable engineering skills: PR audit, CI triage, change impact, release readiness, and more.",
      "version": "$VERSION"
    }
  ]
}
EOF

COUNT=$(find "$OUT/skills" -mindepth 1 -maxdepth 1 -type d | wc -l)
printf 'Built %s (version %s, %s skills)\n' "$OUT" "$VERSION" "$COUNT"
printf 'Update Claude Code with:\n  claude plugin marketplace update pi-kit-marketplace\n  claude plugin install pi-kit@pi-kit-marketplace\n'
