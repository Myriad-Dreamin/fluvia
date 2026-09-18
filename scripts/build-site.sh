#!/usr/bin/env bash
# Assemble the GitHub Pages site into site/:
#   /        the browser app (pi-web-fluvia), the demo
#   /slice/  the interactive slice page over the shipped recording
#   /docs/   the documentation site
set -euo pipefail
cd "$(dirname "$0")/.."
export FLUVIA_BASE="${FLUVIA_BASE:-/fluvia/}"
pnpm build
node packages/cli/bin/fluvia.js slice page --standalone \
  --trace packages/toolbox-default/traces/demo.jsonl.gz --out site/slice/index.html
rm -rf docs/.vitepress/dist
pnpm docs:build
rm -rf site/docs site/assets site/index.html
cp -r packages/pi-web-fluvia/dist/. site/
cp -r docs/.vitepress/dist site/docs
touch site/.nojekyll
du -sh site
