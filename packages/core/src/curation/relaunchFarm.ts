/**
 * Same-ticker launches just before a token: other mints with its ticker first seen in the
 * RELAUNCH_FARM_WINDOW_MINUTES before it, read by the worker (relaunchFarms.ts) and recorded as
 * the relaunchSiblings / relaunchSiblingPeakMcapUsd inputs. The highest market cap among them is
 * read only once the count reaches RELAUNCH_FARM_MIN_SIBLINGS (0 below), as it was when the inputs
 * started being banked, so recorded rows stay comparable.
 *
 * They once fed a block on model calls (2026-10-14: 4+ copies in 15 minutes, none past $20k),
 * removed by user decision 2026-10-19. On graded event moments 2026-10-16 19:24 to 10-19 14:31 it
 * blocked 13% of moments, ~280 likely calls, and those doubled inside the hour 20.4% of the time
 * against 19.5% for the calls made: mostly common tickers (ELON, AI, CAT) launched again and
 * again, not farms (notes/ticker-guard-2026-10-19).
 */
export const RELAUNCH_FARM_WINDOW_MINUTES = 15;
export const RELAUNCH_FARM_MIN_SIBLINGS = 4;
