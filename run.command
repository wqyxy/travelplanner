#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
if [ -x "$ROOT/runtime/bin/node" ]; then exec "$ROOT/runtime/bin/node" dist/server/index.js; fi
exec node dist/server/index.js
