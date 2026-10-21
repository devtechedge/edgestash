#!/usr/bin/env bash
# Runs REA (rea-agents >= 6.7, Node >= 22.19) static JavaScript analysis on the
# installed SDK packages. Raw Evidence is gzipped to evidence/raw (attached to
# releases, not committed); scripts/digest-evidence.mjs extracts committed digests.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NM="$ROOT/packages/server/node_modules"
mkdir -p "$ROOT/evidence/raw"
for spec in "vercel-blob:@vercel/blob" "upstash-redis:@upstash/redis" "upstash-ratelimit:@upstash/ratelimit"; do
  name="${spec%%:*}"; pkg="${spec#*:}"
  dir="$(readlink -f "$NM/$pkg")"
  echo "rea analyze-javascript-application $pkg" >&2
  rea analyze-javascript-application "$dir" --artifact-format directory --format json > "$ROOT/evidence/raw/$name.json"
  gzip -9 -f "$ROOT/evidence/raw/$name.json"
done
node "$ROOT/scripts/digest-evidence.mjs"
