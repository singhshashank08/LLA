#!/usr/bin/env bash
# Local verification (nothing is deployed or uploaded). Fixtures contain PII and go to /tmp only.
# Requires: python3 + pandas + openpyxl, node >= 18; for the browser preview: playwright-core + chart.js
#   (set DEPS_DIR to a folder whose node_modules has both; e.g. the original funnel-dashboard/src after `npm install`).
set -euo pipefail
cd "$(dirname "$0")/.."
XLSX="${1:-/workspace/data.xlsx}"
DEPS_DIR="${DEPS_DIR:-/workspace/funnel-dashboard/src}"
echo "== syntax";            node test/check_syntax.js
echo "== fixtures";          python3 test/export_fixture.py "$XLSX" /tmp/fd_fixture
echo "== mock runtime tests"; node test/run_tests.js /tmp/fd_fixture /tmp/fd_out
if [ -d "$DEPS_DIR/node_modules/playwright-core" ]; then
  echo "== browser preview"; NODE_PATH="$DEPS_DIR/node_modules" CHARTJS_DIR="$DEPS_DIR" node test/render_preview.js /tmp/fd_out/payload.json /tmp/fd_out/report.html
else echo "(skipping browser preview: playwright-core not found in $DEPS_DIR)"; fi
