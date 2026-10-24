#!/usr/bin/env bash
# The extension's version rule (user rule 2026-10-24): every change to apps/extension bumps the
# version in static/manifest.json, and package.json carries the same version. The Chrome Web Store
# refuses an upload whose version isn't higher than the last, and a bump per change keeps each
# build traceable to its commit.
#
# Compares against BASE_REF (default main): run on a pull request's merge commit, or locally on a
# branch. Without a base to compare (a push to main), only the two versions' agreement is checked.
set -euo pipefail

EXT=apps/extension
BASE_REF=${BASE_REF:-main}

manifest_version=$(node -p "require('./$EXT/static/manifest.json').version")
package_version=$(node -p "require('./$EXT/package.json').version")
if [[ "$manifest_version" != "$package_version" ]]; then
  echo "::error::$EXT: manifest version $manifest_version differs from package.json $package_version"
  exit 1
fi

if ! git fetch --quiet --depth=1 origin "$BASE_REF" 2>/dev/null; then
  echo "no $BASE_REF to compare with; versions agree at $manifest_version"
  exit 0
fi
if git diff --quiet FETCH_HEAD HEAD -- "$EXT"; then
  echo "$EXT unchanged"
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
  echo "::error::$EXT changed but its version did not go up ($base_version on $BASE_REF, $manifest_version here). Bump static/manifest.json and package.json."
  exit 1
fi
echo "$EXT version $base_version -> $manifest_version"
