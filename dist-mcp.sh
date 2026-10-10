#!/usr/bin/env bash
# Copy the pi extension entry point next to dist/ so the built package works
# standalone: dist/extension.js (jiti shim) + dist/extension.ts (real source).
# Relative "./client.js" imports then resolve in BOTH modes:
#   - pi source mode: src/extension.ts --jiti--> src/client.ts
#   - built mode:     dist/extension.js --jiti--> dist/extension.ts --> dist/client.js
set -euo pipefail
cd "$(dirname "$0")"
cp src/extension.ts dist/extension.ts
printf '%s\n' 'export { default } from "./extension.ts";' > dist/extension.js
