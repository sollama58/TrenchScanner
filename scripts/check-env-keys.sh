#!/usr/bin/env bash
# Checks render.yaml's environment variables against what the code reads, in three ways:
#
#  1. Every `- key: NAME` under `envVars` in render.yaml must be a top-level key of the zod
#     `envSchema` in packages/core/src/config/env.ts. A key set on Render that the schema never
#     reads is a setting nobody is honouring - the usual way a tunable gets renamed in code and
#     silently keeps its old value in production.
#  2. The other way round, for the keys in REQUIRED below: each service that reads one must
#     declare it, if only as `sync: false`. A key that lives only in the Render dashboard is lost
#     when the Blueprint is re-created, and nothing says which service needed it. Which service
#     reads a key cannot be worked out from the code reliably (the worker build runs as both the
#     scanner and the trainer), so the list is kept by hand, each entry checked against the code.
#  3. Code in apps/*/src and packages/*/src (tests excluded) may read `process.env.NAME` only for a
#     schema key or a key in DIRECT_READS. Anything else is a setting the schema, this check and
#     .env.example never hear of.
set -euo pipefail
cd "$(dirname "$0")/.."

RENDER_YAML=render.yaml
ENV_TS=packages/core/src/config/env.ts

# Keys Render itself consumes, or that reach the process some other way than the schema.
IGNORE=(
  NODE_VERSION
  # Read by the web build (import.meta.env in apps/web), not by the API or worker's schema.
  VITE_API_URL
  # Read by the nightly full-database dump's shell script (scripts/db-backup), not by Node.
  DB_DUMP_KEEP
  DB_DUMP_COMPRESS
)

# Keys the code reads straight from process.env, outside the schema, and why. Each may also be
# set in render.yaml.
DIRECT_READS=(
  # Set by Render's shared group and read before the schema loads (db.ts, apps/api/src/index.ts).
  NODE_ENV
  # Set by Render on a web service; the API listens on it.
  PORT
  # The SSE subscriber ceiling, read once when apps/api/src/matchStream.ts loads (default 2000).
  MAX_STREAM_SUBSCRIBERS
  # Optional overrides for the trading bot's one-off mainnet preflight
  # (apps/worker/src/tradingPreflight.ts), run by hand, never by a service.
  PREFLIGHT_PROBE_WALLET
  PREFLIGHT_PUMP_MINT
)

# "service KEY" pairs: the service reads KEY, so render.yaml must declare it there (point 2).
REQUIRED=(
  "trenchscanner-api DATABASE_URL"
  "trenchscanner-worker DATABASE_URL"
  "trenchscanner-trainer DATABASE_URL"
  "trenchscanner-api JWT_SECRET"
  "trenchscanner-api ADMIN_WALLET_ADDRESSES"
  # The Telegram dispatcher sends real-time alerts to admin wallets' chats (telegram/dispatch.ts).
  "trenchscanner-worker ADMIN_WALLET_ADDRESSES"
  "trenchscanner-worker WORKER_ROLE"
  "trenchscanner-trainer WORKER_ROLE"
  "trenchscanner-api HELIUS_API_KEY"
  "trenchscanner-worker HELIUS_API_KEY"
  "trenchscanner-worker ANTHROPIC_API_KEY"
  "trenchscanner-trainer ANTHROPIC_API_KEY"
  "trenchscanner-api TELEGRAM_BOT_TOKEN"
  "trenchscanner-worker TELEGRAM_BOT_TOKEN"
  # The scanner's narrative prefetch (apps/worker/src/tokensage/prefetch.ts).
  "trenchscanner-worker TOKENSAGE_API_URL"
  "trenchscanner-worker TOKENSAGE_API_KEY"
  # Admin > API usage reads TokenSage's own meter (apps/api/src/routes/adminUsage.ts).
  "trenchscanner-api TOKENSAGE_API_URL"
  "trenchscanner-api TOKENSAGE_ADMIN_KEY"
  # Every process with a DexScreener client has the CoinGecko fallback behind it: the API's
  # lookups (server.ts), the scan, and the trainer's nightly outcome sweep (outcome-tracking).
  "trenchscanner-api COINGECKO_API_KEY"
  "trenchscanner-worker COINGECKO_API_KEY"
  "trenchscanner-trainer COINGECKO_API_KEY"
  # The off-site model backup copy, made by model-backup on the trainer (curation/modelBackup.ts).
  "trenchscanner-trainer MODEL_BACKUP_S3_ENDPOINT"
  "trenchscanner-trainer MODEL_BACKUP_S3_BUCKET"
  "trenchscanner-trainer MODEL_BACKUP_S3_ACCESS_KEY_ID"
  "trenchscanner-trainer MODEL_BACKUP_S3_SECRET_ACCESS_KEY"
  # The nightly full-database dump to the same bucket (scripts/db-backup/backup.sh).
  "trenchscanner-db-backup DATABASE_URL"
  "trenchscanner-db-backup MODEL_BACKUP_S3_ENDPOINT"
  "trenchscanner-db-backup MODEL_BACKUP_S3_BUCKET"
  "trenchscanner-db-backup MODEL_BACKUP_S3_ACCESS_KEY_ID"
  "trenchscanner-db-backup MODEL_BACKUP_S3_SECRET_ACCESS_KEY"
)

failed=0

# Top-level schema keys: the lines of the z.object literal indented by exactly two spaces. A
# chained schema may break the line after `z` (`JWT_SECRET: z` then `.string()`), so the match
# stops at `z` and allows the dot on the same line or the next. A key may also take a schema
# defined once and shared (`HELIUS_API_KEY: pastedKey,`).
schema_keys=$(grep -E '^  [A-Z][A-Z0-9_]*: (z(\.|\s*$)|[A-Za-z_][A-Za-z0-9_]*,?\s*$)' "$ENV_TS" | sed -E 's/^  ([A-Z0-9_]+):.*/\1/' | sort -u)
if [ -z "$schema_keys" ]; then
  echo "check-env-keys: found no schema keys in $ENV_TS - has its layout changed?" >&2
  exit 1
fi
known_keys=$(printf '%s\n' "$schema_keys" "${DIRECT_READS[@]}" | sort -u)

# Every key render.yaml sets, as "owner KEY", where the owner is the service (or env var group)
# whose envVars list it. A key may carry a trailing comment or quotes (`- key: "NAME" # note`);
# the match allows both, so such a line is still checked rather than silently skipped.
render_pairs=$(awk '
  /^[a-zA-Z]/ { owner = "" }
  /^  - (type|name):/ { owner = "" }
  /^  - name:/ { owner = $3 }
  /^    name:/ { owner = $2 }
  /^[ \t]*- key: ["'"'"']?[A-Za-z][A-Za-z0-9_]*["'"'"']?[ \t]*(#.*)?$/ {
    key = $3; gsub(/["'"'"']/, "", key); print owner, key
  }
' "$RENDER_YAML")
render_keys=$(cut -d' ' -f2 <<<"$render_pairs" | sort -u)
if [ -z "$render_keys" ]; then
  echo "check-env-keys: found no envVars keys in $RENDER_YAML - has its layout changed?" >&2
  exit 1
fi

# 1. render.yaml -> schema.
unknown=()
for key in $render_keys; do
  if printf '%s\n' "${IGNORE[@]}" | grep -qx "$key"; then continue; fi
  if ! grep -qx "$key" <<<"$known_keys"; then unknown+=("$key"); fi
done
if [ "${#unknown[@]}" -gt 0 ]; then
  echo "check-env-keys: $RENDER_YAML sets keys that $ENV_TS does not read:" >&2
  printf '  %s\n' "${unknown[@]}" >&2
  echo "Add them to envSchema, remove them from render.yaml, or list them in IGNORE in $0." >&2
  failed=1
fi

# 2. Keys a service reads -> that service's envVars.
missing=()
for pair in "${REQUIRED[@]}"; do
  if ! grep -qxF "$pair" <<<"$render_pairs"; then missing+=("$pair"); fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "check-env-keys: these services read keys their $RENDER_YAML entry does not declare (service key):" >&2
  printf '  %s\n' "${missing[@]}" >&2
  echo "Declare each under that service's envVars (\`sync: false\` for a secret), or fix REQUIRED in $0." >&2
  failed=1
fi

# 3. process.env reads -> schema or DIRECT_READS.
direct=$(grep -rhoE --include='*.ts' --include='*.tsx' --exclude='*.test.ts' --exclude='*.test.tsx' \
  "process\.env(\.[A-Z_][A-Z0-9_]*|\[[\"'][A-Z_][A-Z0-9_]*[\"']\])" apps/*/src packages/*/src |
  sed -E "s/^process\.env(\.|\[[\"'])([A-Z0-9_]+).*/\2/" | sort -u || true)
stray=()
for key in $direct; do
  if ! grep -qx "$key" <<<"$known_keys"; then stray+=("$key"); fi
done
if [ "${#stray[@]}" -gt 0 ]; then
  echo "check-env-keys: code reads process.env keys that neither $ENV_TS nor DIRECT_READS knows:" >&2
  printf '  %s\n' "${stray[@]}" >&2
  echo "Read them through envSchema, or list them with a reason in DIRECT_READS in $0." >&2
  failed=1
fi

[ "$failed" -eq 0 ] && echo "check-env-keys: render.yaml, the env schema and direct process.env reads agree ($(wc -l <<<"$render_keys" | tr -d ' ') render.yaml keys, ${#REQUIRED[@]} required declarations, $(wc -w <<<"$direct" | tr -d ' ') direct reads)"
exit "$failed"
