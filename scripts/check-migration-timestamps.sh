#!/usr/bin/env bash
# Fails when two migration directories share the same 14-digit timestamp prefix.
#
# Prisma applies migrations in the lexical order of their directory names. When two share a
# timestamp, their order falls to the name after it (`_burn_credits` before `_cex_funded`), not to
# when each was written, so a migration that depends on another can run first the day their names
# happen to sort the other way. It happens because parallel branches each pick the next round
# hour (20261013230000) for a migration written at about the same time, and neither sees the
# other's until both are merged.
#
# The pairs already on main are listed in GRANDFATHERED: none depends on its twin (full audit
# 2026-10-14, lane 7), and an applied migration is never renamed. A new migration that reuses one
# of their timestamps still fails.
set -euo pipefail
cd "$(dirname "$0")/.."

MIGRATIONS=${MIGRATIONS_DIR:-packages/core/prisma/migrations}
GRANDFATHERED=(
  20261006190000_feed_appearance
  20261006190000_tokensage_groundwork
  20261007210000_announcements
  20261007210000_tokensage_lineage_wave
  20261010213000_score_anchor
  20261010213000_telegram_alert_sent
  20261012070000_curated_live_mcap
  20261012070000_narrative_x_engagement
  20261013190000_burn_credits
  20261013190000_cex_funded
  20261013220000_holder_filters
  20261013220000_narrative_now
  20261013230000_kol_winner_wallets
  20261013230000_linked_wallet_count
  20261013230000_wallet_active_since
  20261014010000_funder_revived
  20261014010000_largest_holder
  20261014040000_holder_set
  20261014040000_kol_side_wallets
  20261014070000_bubble_map_holders
  20261014070000_telegram_models
  20261016030000_feedback_reports
  20261016030000_launchpads
  20261016090000_feed_both_only
  20261016090000_transfers_count
  # Merged into main a few minutes apart on 2026-10-28 (full audit fix threads T10 and T6); each
  # creates its own new table and neither reads the other's.
  20261028000000_asyl_caps
  20261028000000_web_push_alert_sent
)

names=$(find "$MIGRATIONS" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort)
failed=0
for name in $names; do
  if ! [[ "$name" =~ ^[0-9]{14}_ ]]; then
    echo "::error::migration directory $name does not start with a 14-digit timestamp and an underscore"
    failed=1
  fi
done

for stamp in $(cut -c1-14 <<<"$names" | uniq -d); do
  twins=$(grep "^${stamp}_" <<<"$names")
  new=$(grep -vxF "$(printf '%s\n' "${GRANDFATHERED[@]}")" <<<"$twins" || true)
  if [[ -n "$new" ]]; then
    echo "::error::migrations share the timestamp $stamp: $(paste -sd' ' - <<<"$twins") - give each new one ($(paste -sd" " - <<<"$new")) a timestamp of its own"
    failed=1
  fi
done
[[ $failed -eq 0 ]] && echo "check-migration-timestamps: no new migration shares a timestamp ($(wc -l <<<"$names" | tr -d ' ') migrations, ${#GRANDFATHERED[@]} grandfathered)"
exit $failed
