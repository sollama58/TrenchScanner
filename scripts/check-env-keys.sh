#!/usr/bin/env bash
# Fails when render.yaml names an environment variable the config schema does not know.
#
# Every `- key: NAME` under `envVars` in render.yaml is checked against the top-level keys of the
# zod `envSchema` in packages/core/src/config/env.ts. A key set on Render that the schema never
# reads is a setting nobody is honouring - the usual way a tunable gets renamed in code and
# silently keeps its old value in production.
set -euo pipefail
cd "$(dirname "$0")/.."

RENDER_YAML=render.yaml
ENV_TS=packages/core/src/config/env.ts

# Keys Render itself consumes, or that reach the process some other way than the schema.
IGNORE=(
  NODE_VERSION
  PORT
  NODE_ENV
  # Read by the web build (import.meta.env in apps/web), not by the API or worker's schema.
  VITE_API_URL
)

# Top-level schema keys: the lines of the z.object literal indented by exactly two spaces. A
# chained schema may break the line after `z` (`JWT_SECRET: z` then `.string()`), so the match
# stops at `z` and allows the dot on the same line or the next.
schema_keys=$(grep -E '^  [A-Z][A-Z0-9_]*: z(\.|\s*$)' "$ENV_TS" | sed -E 's/^  ([A-Z0-9_]+):.*/\1/' | sort -u)
if [ -z "$schema_keys" ]; then
  echo "check-env-keys: found no schema keys in $ENV_TS - has its layout changed?" >&2
  exit 1
fi

# Every key render.yaml sets, in any service's or group's envVars.
render_keys=$(grep -E '^\s*- key: [A-Z][A-Z0-9_]*\s*$' "$RENDER_YAML" | sed -E 's/.*- key: ([A-Z0-9_]+).*/\1/' | sort -u)
if [ -z "$render_keys" ]; then
  echo "check-env-keys: found no envVars keys in $RENDER_YAML - has its layout changed?" >&2
  exit 1
fi

unknown=()
for key in $render_keys; do
  if printf '%s\n' "${IGNORE[@]}" | grep -qx "$key"; then continue; fi
  if ! printf '%s\n' "$schema_keys" | grep -qx "$key"; then unknown+=("$key"); fi
done

if [ "${#unknown[@]}" -gt 0 ]; then
  echo "check-env-keys: $RENDER_YAML sets keys that $ENV_TS does not read:" >&2
  printf '  %s\n' "${unknown[@]}" >&2
  echo "Add them to envSchema, remove them from render.yaml, or list them in IGNORE in $0." >&2
  exit 1
fi

echo "check-env-keys: every render.yaml key is in the env schema ($(printf '%s\n' "$render_keys" | wc -l | tr -d ' ') keys checked)"
