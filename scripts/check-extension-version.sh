#!/usr/bin/env bash
# The extension's version rule (user rule 2026-10-24): every change to apps/extension bumps the
# version in static/manifest.json, and package.json carries the same version. The Chrome Web Store
# refuses an upload whose version isn't higher than the last, and a bump per change keeps each
# build traceable to its commit.
#
# What it compares against:
# - BASE_SHA when set: a fixed commit CI picks (ci.yml): on a push to main the commit main moved
#   from, on a pull request the base its merge commit was made on. So a run is checked against
#   what it actually changed. Comparing with the current main instead failed a merge that landed
#   just after another extension bump (run 40549020208), and on main itself compared main with
#   main and proved nothing (full audit 2026-10-27, CH-7).
# - otherwise BASE_REF (default main): a pull request's base, or main when run locally on a branch.
# Without a base to compare (none fetchable, or a new branch's all-zero "before"), only the two
# versions' agreement is checked.
set -euo pipefail

EXT=apps/extension
BASE_REF=${BASE_REF:-main}
BASE_SHA=${BASE_SHA:-}
if [[ "$BASE_SHA" =~ ^0+$ ]]; then BASE_SHA=""; fi
BASE=${BASE_SHA:-$BASE_REF}

manifest_version=$(node -p "require('./$EXT/static/manifest.json').version")
package_version=$(node -p "require('./$EXT/package.json').version")
if [[ "$manifest_version" != "$package_version" ]]; then
  echo "::error::$EXT: manifest version $manifest_version differs from package.json $package_version"
  exit 1
fi

if ! git fetch --quiet --depth=1 origin "$BASE" 2>/dev/null; then
  echo "no $BASE to compare with; versions agree at $manifest_version"
  exit 0
fi
if git diff --quiet FETCH_HEAD HEAD -- "$EXT"; then
  echo "$EXT unchanged since $BASE"
  exit 0
fi
base_version=$(git show "FETCH_HEAD:$EXT/static/manifest.json" 2>/dev/null | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).version" || echo "0.0.0")
# Higher, compared part by part as Chrome does.
if ! node -e '
  const [a, b] = process.argv.slice(1).map((v) => v.split(".").map(Number));
  for (let i = 0; i < 4; i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) process.exit(x > y ? 0 : 1);
  }
  process.exit(1);
' "$manifest_version" "$base_version"; then
  echo "::error::$EXT changed but its version did not go up ($base_version on $BASE, $manifest_version here). Bump static/manifest.json and package.json."
  exit 1
fi
echo "$EXT version $base_version -> $manifest_version"
