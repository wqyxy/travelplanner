#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_ROOT="${1:?用法：bash scripts/build_portable_macos.sh <官方Node.js 24目录> [输出目录]}"
OUTPUT="${2:-$ROOT/release}"
PORTABLE="$OUTPUT/ai-travel-planner-macos-arm64"
NODE="$NODE_ROOT/bin/node"
if [ ! -x "$NODE" ] || [ "$("$NODE" -p process.platform)" != darwin ] || [ "$("$NODE" -p process.arch)" != arm64 ] || [ "$("$NODE" -p process.versions.node | cut -d. -f1)" != 24 ]; then echo '需要官方 macOS Apple Silicon Node.js 24 运行时。' >&2; exit 1; fi
cd "$ROOT"
npm run typecheck
npm test
npm run build
rm -rf "$PORTABLE"
mkdir -p "$PORTABLE"
for entry in dist node_modules prompts scripts package.json package-lock.json VERSION run.cmd run.ps1 run.command .gitignore; do cp -R "$ROOT/$entry" "$PORTABLE/$entry"; done
cp -R "$NODE_ROOT" "$PORTABLE/runtime"
chmod +x "$PORTABLE/run.command" "$PORTABLE/scripts/build_portable_macos.sh"
printf '便携版已创建：%s\n' "$PORTABLE"
