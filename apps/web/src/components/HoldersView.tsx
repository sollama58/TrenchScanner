import { useEffect, useMemo, useRef, useState } from "react";
import { api, post, type Card, type ScanVerdict, type Snapshot } from "../api";
import {
  alertWideMap,
  fromAlertText,
  hasHolderList,
  holderBadgeAt,
  holderListAt,
  holderShownAt,
  liveWideFor,
  momentLabel,
  momentSnapshot,
  pickReading,
  withWideMap,
  type AlertWideMap,
  type BubbleMoment,
} from "../bubbleMap";
import { cachedGet } from "../cache";
import { MAX_HISTORY, useLiveTrades } from "../liveTrades";
import { coversFrom, type LiveTradeShares } from "../liveShares";
import { linkedReading } from "./AlertCard";
import { reloadBubbleMaps, useBubbleMaps } from "./BubbleMap";
import { LiveStamp } from "./Freshness";

/**
 * The token view's Holders reading, shared by the token modal and the browser extension's copy of
 * the site's bubble map (TokenMapView, user ask 2026-10-25): the coin's newest scans, followed live,
 * which reading the map draws, the At the alert and kept-moment views, and their freshness lines.
 */
/**
 * How often an open token view reads the coin's newest scans (GET /tokens/:mint?reading=1, which
 * the API shares between readers for 10 s): the scan writes a coin's row every 10-20 s
 * in the band (measured 2026-10-19), so each read nearly always brings a newer one. One read
 * serves the card's latest scan, the holder reading and the safety screen's history, and the
 * view's "Next update" countdowns count to it (user ask 2026-10-19).
 */
export const SCAN_READ_MS = 15_000;
/** The API holds a holder wait up to 20 s (holderWaits.ts HOLDER_WAIT_MS); the ask gives up after this. */
const HOLDER_WAIT_TIMEOUT_MS = 30_000;
/** Before asking again when the page is hidden, the API had no wait to hold, or asks keep failing. */
const HOLDER_WAIT_IDLE_MS = 60_000;

/**
 * GET /tokens/:mint?reading=1 (api routes/tokens.ts readTokenReading): of the coin's 50 newest
 * scans, the newest and the one the holder reading draws (pickReading's choice, made by the API),
 * newest first, and every one's safety verdict.
 */
interface CoinReading {
  snapshots?: Snapshot[];
  verdicts?: ScanVerdict[];
}

/** The coin's newest scans as last read (null before the first lands), and when the next read is. */
interface CoinScans {
  /** The newest scan and the holder reading's, newest first (one row when they are the same). */
  snapshots: Snapshot[] | null;
  /** The 50 newest scans' safety verdicts, for the safety flip. */
  verdicts: ScanVerdict[] | null;
  /** Null when the view doesn't follow the scans (a lookup). */
  nextRead: number | null;
}

/**
 * Reads the coin's newest scans every SCAN_READ_MS while the page is visible, and at once when it
 * comes back. A failed read keeps the last one.
 */
export function useCoinScans(mint: string, follow: boolean): CoinScans {
  const [read, setRead] = useState<{
    mint: string;
    snapshots: Snapshot[];
    verdicts: ScanVerdict[];
  } | null>(null);
  const [nextRead, setNextRead] = useState<number | null>(null);
  const mintRef = useRef(mint);
  mintRef.current = mint;
  useEffect(() => {
    if (!follow) return;
    let live = true;
    let timer = 0;
    let generation = 0;
    const tick = (pushed = false) => {
      window.clearTimeout(timer);
      const started = Date.now();
      const mine = ++generation;
      const asked = mint;
      if (document.visibilityState === "visible")
        // A read in the last few seconds (a quick return to the page) is reused, unless the
        // scanner just announced a new holder reading. nextRead moves only once this read has
        // landed. Setting it to the following poll before that made the countdown skip the read
        // in flight and keep calling an old list current (user ask 2026-10-21).
        cachedGet<CoinReading>(
          `/tokens/${encodeURIComponent(asked)}?reading=1`,
          pushed ? -1 : SCAN_READ_MS / 3,
        )
          .then((d) => {
            // `mintRef` moves on the render that switches coins, before this effect cleans up.
            // A response for the coin just left must not land on the one now open.
            if (!live || mine !== generation || mintRef.current !== asked) return;
            setRead({ mint: asked, snapshots: d.snapshots ?? [], verdicts: d.verdicts ?? [] });
          })
          .catch(() => undefined)
          .finally(() => {
            if (live && mine === generation && mintRef.current === asked) setNextRead(started + SCAN_READ_MS);
          });
      timer = window.setTimeout(tick, SCAN_READ_MS);
    };
    tick();
    // The holder wait below sleeps while the page is hidden; showing it again resumes it at once.
    let holding = false;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      tick();
      if (!holding) waitNext(0);
    };
    document.addEventListener("visibilitychange", onVisible);
    // The scanner's word that a new holder reading was written (user decision 2026-10-24): a held
    // ask that answers the moment one is, so the list shows without waiting out the poll above.
    const abort = new AbortController();
    let waitTimer = 0;
    let failures = 0;
    const waitNext = (ms: number) => {
      window.clearTimeout(waitTimer);
      if (live) waitTimer = window.setTimeout(() => void wait(), ms);
    };
    const wait = async () => {
      if (document.visibilityState !== "visible") return waitNext(HOLDER_WAIT_IDLE_MS);
      holding = true;
      try {
        const a = await api<{ changed: boolean; pushed: boolean }>(
          `/tokens/${encodeURIComponent(mint)}/holders/wait`,
          { signal: abort.signal, timeoutMs: HOLDER_WAIT_TIMEOUT_MS },
        );
        if (!live) return;
        failures = 0;
        // The top-50 picture too: a watched coin's new one is announced the same way.
        if (a.changed) {
          tick(true);
          reloadBubbleMaps(mint);
        }
        // No wait could be held (the API at capacity, or an older build): the poll covers it.
        waitNext(a.pushed ? 0 : HOLDER_WAIT_IDLE_MS);
      } catch {
        if (live) waitNext(Math.min(HOLDER_WAIT_IDLE_MS, 2_000 * 2 ** ++failures));
      } finally {
        holding = false;
      }
    };
    void wait();
    return () => {
      live = false;
      abort.abort();
      window.clearTimeout(timer);
      window.clearTimeout(waitTimer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [follow, mint]);
  return {
    snapshots: follow && read?.mint === mint ? read.snapshots : null,
    verdicts: follow && read?.mint === mint ? read.verdicts : null,
    nextRead: follow ? nextRead : null,
  };
}

/**
 * The reading the bubble map and the top holders draw: the card's newest that kept a holder list,
 * else the newest of the coin's scans that did (useCoinScans; a lookup's card is already its latest
 * scan). Undefined while that loads, null when no scan has a list.
 */
export function useHolderReading(
  card: Card,
  lookup: boolean,
  scans: Snapshot[] | null,
): Snapshot | null | undefined {
  const seed = linkedReading(card);
  // Newest first, so the section follows the coin's scans and its "Last updated" means it. A newer
  // scan without a list of its own (an unchanged list rides only some rows, the worker's
  // holderListWrites.ts) has the coin's newest reading read, not the alert's put back: that froze
  // "Now" at the alert once the modal's card followed the scans (user ask 2026-10-19).
  const latest = card.latestSnapshot && hasHolderList(card.latestSnapshot) ? card.latestSnapshot : null;
  const older = [seed, card.snapshot].find((s) => s && hasHolderList(s)) ?? null;
  const own = latest ?? (card.latestSnapshot && !lookup ? null : older);
  // The API already chose (readTokenReading); picking again over its newest and chosen rows
  // lands on the same one.
  const picked = useMemo(() => (scans ? pickReading(scans) : undefined), [scans]);
  if (own) return own;
  if (lookup) return seed;
  // The scans' 50 rows span over ten minutes, past the worker's rewrite of an unchanged list.
  return scans ? (picked ?? seed) : undefined;
}

/**
 * Which moment the Holders reading is from. The call's numbers are the alert's; this section reads
 * the newest scan with a holder list, which can disagree with them (another moment, and often
 * another holder set), so each says which it is.
 */
export function holdersMoment(card: Card, reading: Snapshot | null | undefined) {
  if (!reading) return undefined;
  return reading.takenAt === card.snapshot.takenAt
    ? {
        label: "At the alert",
        title:
          "The reading at the alert, the same one The alert section shows. Counts are over the top holders it read (the /25 or /10).",
      }
    : {
        label: "Latest",
        // Headed with the reading's age, ticking (user ask 2026-10-19).
        at: holderShownAt(reading),
        title:
          "The latest scan's reading, not the alert's: The alert section below shows the holders at the alert. Counts are over the top holders this scan read (the /25 or /10), which can be a different set.",
      };
}

/** Filter alerts this page already told the API were opened. */
const openedFilterAlerts = new Set<string>();

/**
 * Opening one of your filter's alerts keeps the coin's bubble map at that filter's first catch of
 * it (POST /tokens/:mint/bubble-moments/filter, user ask 2026-10-16), once: shown to you, or to
 * everyone for a public filter. Then the kept maps are read again so it is offered at once.
 */
export function useFilterCatchKept(card: Card, utility: boolean) {
  const mint = card.token.mintAddress;
  const isFilterAlert = !utility && card.kind === "match" && !!card.filter;
  useEffect(() => {
    if (!isFilterAlert || openedFilterAlerts.has(card.id)) return;
    openedFilterAlerts.add(card.id);
    post<{ result: string }>(`/tokens/${encodeURIComponent(mint)}/bubble-moments/filter`, {
      matchId: card.id,
    })
      .then((r) => {
        if (r?.result === "kept") reloadBubbleMaps(mint);
      })
      .catch(() => {
        // Nothing to show for it: the next opening tries again.
        openedFilterAlerts.delete(card.id);
      });
  }, [isFilterAlert, card.id, mint]);
}

/**
 * A Holders view: "now", the newest scan's; "alert", as kept at the alert or call; or a kept
 * moment (BubbleMoment), by its id.
 */
export type HoldersView = "alert" | "now" | `moment:${string}`;

/** Which Holders view the modal opened on last: the next token view opens on the same one, where it has it. */
let lastHoldersView: HoldersView = "now";

/** One button on the Holders switch, in time order. */
interface HoldersOption {
  view: HoldersView;
  label: string;
  at: number;
}

/**
 * The Holders section's views (user ask 2026-10-14, 2026-10-16): "At the alert", the holders as
 * they stood when the coin was alerted or called, kept and never updated; the maps kept at the
 * coin's first safety-screen pass and at filters' first catches (BubbleMoment: everyone's, the
 * reader's own filter's, and public filters'); and "Now", the newest scan's.
 * At the alert draws the alert's own scan (its top 25, the numbers The call shows) under the
 * top-50 map kept at the coin's first model call, when that was read near this alert
 * (alertWideMap). A kept moment draws its own top 25 alone. A coin with none of them has only Now.
 */
export function useHoldersView(
  card: Card,
  linked: Snapshot | null | undefined,
  alertAt: number,
  utility: boolean,
) {
  /** What the moment is named in the holders text: a model's alert and a filter's both read "alert". */
  const word = "alert";
  const maps = useBubbleMaps(card.token.mintAddress);
  const [picked, setPicked] = useState<HoldersView>(lastHoldersView);
  const s = card.snapshot;
  const frozen = utility || card.kind === "stream" ? null : alertWideMap(maps?.atAlert, alertAt);
  const alertHasList = !utility && card.kind !== "stream" && hasHolderList(s);
  // Both views would draw the same thing: the newest reading is the alert's and nothing kept differs.
  const same = linked?.takenAt === s.takenAt && !frozen && !maps?.map;
  const alertOffered = (alertHasList || !!frozen) && !same;
  // A filter alert's own catch is the At the alert view already: not offered twice.
  const moments = (maps?.moments ?? []).filter(
    (m) =>
      !(
        alertOffered &&
        card.kind === "match" &&
        m.kind === "filter" &&
        m.mine &&
        Math.abs(Date.parse(m.at) - Date.parse(card.matchedAt)) < 1_000
      ),
  );
  const options: HoldersOption[] = [
    ...(alertOffered ? [{ view: "alert" as const, label: `At the ${word}`, at: alertAt }] : []),
    ...moments.map((m) => ({
      view: `moment:${m.id}` as const,
      label: momentLabel(m).short,
      at: Date.parse(m.at),
    })),
  ].sort((a, b) => a.at - b.at);
  const canSwitch = options.length > 0;
  const view: HoldersView = options.some((o) => o.view === picked) ? picked : "now";
  const atAlert = view === "alert";
  const kept = view === "now" ? null : (moments.find((m) => view === `moment:${m.id}`) ?? null);
  const setView = (v: HoldersView) => {
    lastHoldersView = v;
    setPicked(v);
  };
  const keptReading = kept ? momentSnapshot(s, kept) : null;
  const moment = kept
    ? {
        label: momentLabel(kept).short,
        title: `The holders as they stood ${momentLabel(kept).long}: that scan's top holders, kept and never updated.`,
      }
    : utility
      ? undefined
      : atAlert
        ? {
            label: `At the ${word}`,
            title: frozen
              ? `The holders as they stood at the ${word}: the top 50 read ${fromAlertText(Date.parse(frozen.readAt), alertAt, word)}, kept and never updated. Counts are the ${word}'s own scan (the /25), the same numbers The alert section shows.`
              : `The holders the ${word}'s scan read, kept as they stood: the same reading The alert section shows.`,
          }
        : canSwitch
          ? {
              label: "Latest",
              at: linked ? holderShownAt(linked) : undefined,
              title:
                "The latest scan's reading. Switch to an earlier moment for the holders as they stood then.",
            }
          : holdersMoment(card, linked);
  return {
    word,
    view,
    setView,
    options,
    canSwitch,
    atAlert,
    /** The kept moment on view, if one is. */
    kept,
    /** Any view kept as it stood: the alert's or a moment's. */
    isKept: atAlert || !!kept,
    frozen,
    moment,
    /** The top-50 map to draw over the reading: the one kept at the call, none for a moment, else the live one. */
    wide: atAlert ? { wide: frozen } : kept ? { wide: null } : {},
    /** The reading the map draws. */
    reading: keptReading ?? (atAlert ? s : linked),
    /** The reading the top-holder list draws: the map's, through the kept top 50 when the scan kept no list. */
    listReading: keptReading ?? (atAlert ? (alertHasList ? s : withWideMap(s, frozen)) : linked),
  };
}

/** When a kept moment's holders were read, and that they are kept as they stood. */
export function MomentHoldersWhen({ moment }: { moment: BubbleMoment }) {
  const at = Date.parse(moment.at);
  const hm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day =
    new Date(at).toDateString() === new Date().toDateString()
      ? ""
      : `${new Date(at).toLocaleDateString([], { month: "short", day: "numeric" })}, `;
  const what =
    moment.kind === "screen"
      ? "Passed the screen"
      : `${moment.mine ? "Your filter" : "Public filter"}${moment.filterName ? ` "${moment.filterName}"` : ""} caught it`;
  return (
    <p className="tm-holders-when">
      <b>
        {what} {day}
        {hm(at)}
      </b>{" "}
      ·{" "}
      <span>
        Holders read{" "}
        {fromAlertText(Date.parse(moment.readAt), at, moment.kind === "screen" ? "pass" : "catch")}
      </span>{" "}
      · <span>Kept as it stood</span>
    </p>
  );
}

/** When the holders at the alert were read, and that they are kept as they stood. */
export function AlertHoldersWhen({
  alertAt,
  word,
  frozen,
  reading,
}: {
  alertAt: number;
  word: string;
  frozen: AlertWideMap | null;
  reading: Snapshot | null | undefined;
}) {
  const hm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const readAt = frozen ? Date.parse(frozen.readAt) : reading ? Date.parse(reading.takenAt) : alertAt;
  const day =
    new Date(alertAt).toDateString() === new Date().toDateString()
      ? ""
      : `${new Date(alertAt).toLocaleDateString([], { month: "short", day: "numeric" })}, `;
  return (
    <p className="tm-holders-when">
      <b>
        Alerted {day}
        {hm(alertAt)}
      </b>{" "}
      ·{" "}
      <span>
        Holders read {fromAlertText(readAt, alertAt, word)}
        {frozen && <>, top {frozen.holdersRead}</>}
      </span>{" "}
      · <span>Kept as it stood</span>
    </p>
  );
}

/**
 * When the holder list shown was written, how long ago, and when the next shows (user ask
 * 2026-10-13, 2026-10-19): the same moment the bubble map's badge counts from.
 */
export function HolderFreshness({
  fresh,
  moment,
}: {
  fresh: {
    last: number;
    next: number | null;
    late?: boolean;
    live?: boolean;
    liveUntil?: number | null;
    gone?: boolean;
  };
  moment?: { label: string; title: string };
}) {
  return (
    <p className="tm-holders-when">
      {moment && !fresh.live && <b title={moment.title}>{moment.label} · </b>}
      <LiveStamp
        last={fresh.last}
        next={fresh.next}
        late={fresh.late}
        live={fresh.live}
        liveUntil={fresh.liveUntil}
      />
      {fresh.gone && <> · No further updates: the coin is no longer being scanned</>}
    </p>
  );
}

/**
 * When what the holders show last changed (user ask 2026-10-25: the time on the map is when its
 * data was last updated): the holder set's read (the top 50's, when it is drawn over the scan's
 * list, else the scan's chain read), or the newest live trade since that moved a listed wallet's
 * share, whichever is later. Null for a kept moment or without a list.
 */
export function useHoldersUpdatedAt(
  mint: string,
  reading: Snapshot | null | undefined,
  live: LiveTradeShares | null,
  kept: boolean,
): number | null {
  const wide = liveWideFor(reading, useBubbleMaps(mint)?.map ?? null);
  return useMemo(() => {
    if (kept || !reading || !hasHolderList(reading)) return null;
    let at = holderBadgeAt(reading, wide?.readAt);
    const listAt = holderListAt(reading);
    if (coversFrom(live, listAt)) {
      const listed = new Set([
        ...(reading.linkedHolders ?? []).flatMap((h) => (h ? [h.wallet] : [])),
        ...(wide?.holders ?? []).map((h) => h.wallet),
      ]);
      for (const t of live.trades)
        if (t.tokens > 0 && t.atMs > listAt && t.atMs > at && listed.has(t.wallet)) at = t.atMs;
    }
    return at;
  }, [kept, reading, wide, live]);
}

/**
 * The coin's live trades and supply for the holder shares between reads (user ask 2026-10-19):
 * the token view follows the coin's trades while it is open (user decision 2026-10-24: every open
 * view, not only the Live trades tab), so the bubble map and Top holders move within a second or
 * two of each trade. The API shares one follow per coin and caps them (4 an account, 50 in all);
 * a coin past the cap reads "unavailable" and its shares stay the reading's. None for a kept
 * moment, which stands as it was. A feed that stopped is not used: the trades since it stopped are
 * missing.
 */
export function useLiveShares(base: string, kept: boolean): LiveTradeShares | null {
  const feed = useLiveTrades(base, !kept);
  return useMemo(
    () =>
      kept || feed.status !== "live" || feed.supply === null || feed.wholeFrom === null
        ? null
        : {
            trades: feed.history,
            supply: feed.supply,
            // The page's history keeps the newest MAX_HISTORY: with that many, it starts at its oldest.
            wholeFrom:
              feed.history.length >= MAX_HISTORY && feed.history[0]
                ? Math.max(feed.wholeFrom, feed.history[0].atMs)
                : feed.wholeFrom,
          },
    [kept, feed.history, feed.supply, feed.status, feed.wholeFrom],
  );
}
