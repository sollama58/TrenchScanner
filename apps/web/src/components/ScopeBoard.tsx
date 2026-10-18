import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Card, CardField, LaunchPage, MatchPage } from "../api";
import { usePolling, usePollingAll, useLiveMarketCaps, useNow, useNudgeStream } from "../hooks";
import { joinPages } from "../feedFill";
import { change, pct, tokenLabel, usd } from "../format";
import { cardOutcome, outcomeBadge } from "../outcome";
import { useAppearance } from "../appearance";
import { tileLook, tileMode, tileTone, type TileMode } from "../tileTone";
import { openTokenModal } from "../tokenModal";
import {
  frameOf,
  holdFrame,
  SCOPE_COLUMNS,
  SCOPE_PAGES,
  scopeTickIds,
  shortAge,
  splitScope,
  type ScopeColumn,
  type ScopeColumns,
  type ScopeFrame,
} from "../scope";
import {
  belowMcapLine,
  cardReadings,
  countCutFor,
  newestStats,
  nowReading,
  recordedPeakOf,
  SAFETY_MAX_FRESH_WALLET_PCT,
  SAFETY_REJECT_LINKED_COUNT,
  SAFETY_REJECT_SNIPER_WALLET_PCT,
  SAFETY_REJECT_TOP10_HOLDER_PCT,
  socialLinks,
} from "./AlertCard";
import { QuickBuyPill } from "./QuickBuyPill";
import { TokenImage } from "./TokenImage";
import { FilterGlyph } from "./FilterBadge";
import { BrainIcon, SlidersIcon } from "./Icons";
import { SkeletonCards } from "./Charts";

/** After a finger lifts, the board stays still this long before new rows drop in. */
const TOUCH_HOLD_MS = 4_000;

/** Clicks on these inside a row do their own thing rather than open the token modal. */
const OWN_CLICK = "a, button, input, select, textarea, label, summary, [role='button']";

/** The graduated column's list: the Stream's graduated tokens, polled as often as the Stream. */
const GRADUATED_PATH = "/launches?graduated=1";
const GRADUATED_POLL_MS = 10_000;

/**
 * Scope (user ask 2026-10-18): the Live feed's alerts as a dense three-column board of compact
 * rows - your filters' alerts, the models' calls, and every graduated token that passes the
 * safety screen - with the Live feed's card settings and token window. The board
 * holds still while a pointer or finger is on it; new alerts wait behind a "N new" pill.
 * On phones the columns sit side by side in a strip you swipe, with tabs above.
 */
export function ScopeBoard({
  feedPath,
  hide,
  modelsOn,
}: {
  /** The Live feed's page `n`, so Scope reads exactly what the cards view does. */
  feedPath: (n: number) => string;
  hide: ReadonlySet<CardField>;
  modelsOn: boolean;
}) {
  // Rows say their age in seconds at first, so the board ticks faster than the cards view.
  const now = useNow(5_000);
  const look = useAppearance();
  const first = usePolling<MatchPage>(feedPath(1), 30_000);
  const morePaths = Array.from({ length: SCOPE_PAGES - 1 }, (_, i) => feedPath(i + 2));
  const more = usePollingAll<MatchPage>(morePaths, 30_000);
  const nudged = () => first.reload();
  useNudgeStream("/curated/stream", nudged, modelsOn);
  useNudgeStream("/matches/stream", nudged);
  const graduated = usePolling<LaunchPage>(GRADUATED_PATH, GRADUATED_POLL_MS);
  const buffer = useMemo(
    () =>
      first.data
        ? [...joinPages([first.data, ...more.data]), ...(graduated.data?.launches ?? [])]
        : undefined,
    [first.data, more.data, graduated.data],
  );
  const [tickIds, setTickIds] = useState<string[] | undefined>(undefined);
  const cards = useLiveMarketCaps(buffer, tickIds);

  // Customize's "hide below this market cap", with the Live feed's margin so a coin at the line
  // doesn't flicker.
  const wasHidden = useRef<ReadonlySet<string>>(new Set());
  const visible = useMemo(() => {
    if (!cards) return undefined;
    const hiddenNow = new Set<string>();
    const out = cards.filter((c) => {
      const below = belowMcapLine(c, look, wasHidden.current.has(c.id));
      if (below) hiddenNow.add(c.id);
      return !below;
    });
    wasHidden.current = hiddenNow;
    return out;
  }, [cards, look]);
  const fresh = useMemo(
    () =>
      visible
        ? splitScope(
            visible.filter((c) => c.kind !== "stream"),
            visible.filter((c) => c.kind === "stream"),
          )
        : undefined,
    [visible],
  );

  // Holding still: the frame drawn when the board paused, refreshed in place.
  const [frame, setFrame] = useState<ScopeFrame | null>(null);
  const lastCards = useRef(new Map<string, Card>());
  useEffect(() => {
    for (const c of visible ?? []) lastCards.current.set(c.id, c);
  }, [visible]);
  const held = useMemo(
    () => (fresh && frame ? holdFrame(frame, fresh, lastCards.current) : null),
    [fresh, frame],
  );
  const cols: ScopeColumns | undefined = held?.cols ?? fresh;
  const pending = held?.pending ?? 0;

  const tickKey = cols ? scopeTickIds(cols).join(",") : "";
  useEffect(() => setTickIds(tickKey ? tickKey.split(",") : undefined), [tickKey]);

  const freshRef = useRef(fresh);
  freshRef.current = fresh;
  const touchTimer = useRef<number | undefined>(undefined);
  const pause = useCallback(() => {
    window.clearTimeout(touchTimer.current);
    setFrame((f) => f ?? (freshRef.current ? frameOf(freshRef.current) : null));
  }, []);
  const resume = useCallback(() => {
    window.clearTimeout(touchTimer.current);
    setFrame(null);
  }, []);
  const resumeSoon = useCallback(() => {
    window.clearTimeout(touchTimer.current);
    touchTimer.current = window.setTimeout(() => setFrame(null), TOUCH_HOLD_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(touchTimer.current), []);
  // "N new": show them now, and keep holding still if the pointer is still on the board.
  const showNew = () => {
    if (!fresh) return;
    setFrame((f) => (f ? frameOf(fresh) : null));
  };

  // Phones: the strip of columns scrolls sideways a column at a time; the tabs follow it.
  const strip = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<ScopeColumn>("filters");
  const onStripScroll = () => {
    const el = strip.current;
    if (!el || el.clientWidth === 0) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    const col = SCOPE_COLUMNS[Math.min(SCOPE_COLUMNS.length - 1, Math.max(0, i))];
    if (col && col.id !== active) setActive(col.id);
  };
  const goToColumn = (id: ScopeColumn) => {
    const el = strip.current;
    const i = SCOPE_COLUMNS.findIndex((c) => c.id === id);
    setActive(id);
    el?.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
  };

  if (first.error && !first.data)
    return <p className="error">Couldn&apos;t load your feed: {first.error.message}</p>;
  if (!cols) return <SkeletonCards count={3} />;

  const tiles = tileMode(look);
  return (
    <div
      className={`scope${frame ? " held" : ""}${first.stale ? " stale" : ""}`}
      onPointerEnter={(e) => e.pointerType === "mouse" && pause()}
      onPointerLeave={(e) => e.pointerType === "mouse" && resume()}
      onTouchStart={pause}
      onTouchEnd={resumeSoon}
      onTouchCancel={resumeSoon}
    >
      <div className="scope-bar">
        <div className="segmented small scope-tabs" role="tablist" aria-label="Scope columns">
          {SCOPE_COLUMNS.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={active === c.id}
              className={active === c.id ? "on" : ""}
              onClick={() => goToColumn(c.id)}
            >
              {c.short} <span className="num muted">{cols[c.id].length}</span>
            </button>
          ))}
        </div>
        <span
          className="scope-hold muted small"
          aria-live="polite"
          title={
            frame
              ? "Held still while you read: new rows wait behind the New pill"
              : "New rows land as they come"
          }
        >
          {frame ? "Paused" : "Live"}
        </span>
        {pending > 0 && (
          <button type="button" className="scope-new" onClick={showNew}>
            {pending} new
          </button>
        )}
      </div>
      <div className="scope-strip" ref={strip} onScroll={onStripScroll}>
        {SCOPE_COLUMNS.map((c) => (
          <section key={c.id} className={`scope-col scope-col-${c.id}`} aria-label={c.label}>
            <header className="scope-col-head" title={c.hint}>
              <h3>{c.label}</h3>
              <span className="num muted">{cols[c.id].length}</span>
            </header>
            <div className="scope-rows">
              {cols[c.id].length === 0 ? (
                <p className="muted small scope-empty">{emptyText(c.id, modelsOn, graduated.error)}</p>
              ) : (
                cols[c.id].map((card) => (
                  <ScopeRow key={card.id} card={card} now={now} hide={hide} tiles={tiles} />
                ))
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function emptyText(col: ScopeColumn, modelsOn: boolean, gradError: Error | null): string {
  if (col === "filters") return "Nothing from your filters among the newest alerts.";
  if (col === "models")
    return modelsOn ? "No model calls among the newest alerts." : "Model alerts are off in Settings.";
  return gradError
    ? `Couldn't load graduated tokens: ${gradError.message}`
    : "No graduated token has passed the safety screen in the last day.";
}

/** One alert as a compact row: avatar, ticker and age, where it came from, the figures, and safety chips. */
export function ScopeRow({
  card,
  now,
  hide,
  tiles,
}: {
  card: Card;
  now: number;
  hide: ReadonlySet<CardField>;
  tiles: TileMode;
}) {
  const show = (f: CardField) => !hide.has(f);
  const open = () => openTokenModal(card, now);
  const onClick = (e: React.MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0) return;
    if ((e.target as Element).closest?.(OWN_CLICK)) return;
    open();
  };
  const curated = card.curated;
  const calls = curated?.calledBy ?? [];
  const filter = card.kind === "match" ? card.filter : null;
  const outcome = cardOutcome(card, now);
  const badge = outcomeBadge(outcome);
  const mark = outcome && badge.tone !== "neutral" && badge.tone !== "info" ? badge.text.split(" ")[0] : null;
  const alertMcap = card.snapshot.marketCapUsd;
  const nowMcap = nowReading(card);
  const move = change(alertMcap, nowMcap);
  const { pct: recorded } = recordedPeakOf(card);
  const peak = move !== null && move > 0 ? Math.max(recorded ?? 0, move) : recorded;
  const alertedAt = curated?.alertedAt ?? card.matchedAt;
  const age = shortAge(now - Date.parse(card.kind === "match" ? card.matchedAt : alertedAt));
  const socials = show("socials") ? socialLinks(card.token) : [];
  const label = tokenLabel(card.token);
  const high = calls.some((c) => c.tier === "high") || curated?.tier === "high";
  const models =
    calls.length > 0
      ? calls.map((c) => c.modelName ?? "Model")
      : curated
        ? [curated.modelName ?? "Model"]
        : [];
  const r = cardReadings(card, "newest");
  const t = newestStats(card);
  const chips: {
    key: string;
    label: string;
    value: string;
    title: string;
    tone: number | null;
    risky: boolean;
  }[] = [];
  if (show("holders") && t.holders != null)
    chips.push({
      key: "h",
      label: "Hold",
      value: t.holders.toLocaleString(),
      title: "Holders",
      tone: null,
      risky: false,
    });
  if (show("top10") && t.top10Pct != null)
    chips.push({
      key: "t10",
      label: "T10",
      value: pct(t.top10Pct),
      title: "Top 10 holders' share of supply",
      tone: tileTone(t.top10Pct, SAFETY_REJECT_TOP10_HOLDER_PCT),
      risky: t.top10Pct >= SAFETY_REJECT_TOP10_HOLDER_PCT,
    });
  if (show("fresh") && r.freshPct != null)
    chips.push({
      key: "fr",
      label: "Fresh",
      value: pct(r.freshPct),
      title: "Top holders on fresh wallets",
      tone: tileTone(r.freshPct, SAFETY_MAX_FRESH_WALLET_PCT),
      risky: r.freshPct >= SAFETY_MAX_FRESH_WALLET_PCT,
    });
  if (show("snipers") && r.snipers)
    chips.push({
      key: "sn",
      label: "Snip",
      value: `${r.snipers.count}/${r.snipers.of}`,
      title: "Top holders who were among the launch's first 25 buyers",
      tone: tileTone(r.snipers.top10Pct, SAFETY_REJECT_SNIPER_WALLET_PCT),
      risky: (r.snipers.top10Pct ?? 0) >= SAFETY_REJECT_SNIPER_WALLET_PCT,
    });
  if (show("linked") && r.linkedPct != null) {
    const cut = countCutFor(SAFETY_REJECT_LINKED_COUNT, r.linkedCount?.of);
    chips.push({
      key: "ln",
      label: "Link",
      value: pct(r.linkedPct),
      title: r.linkedCount
        ? `${r.linkedCount.linked} of the top ${r.linkedCount.of} holders are linked`
        : "Supply held by linked wallets",
      tone: r.linkedCount ? tileTone(r.linkedCount.linked, cut) : null,
      risky: !!r.linkedCount && r.linkedCount.linked >= cut,
    });
  }

  return (
    <article className={`scope-row tone-${badge.tone}`} onClick={onClick}>
      <QuickBuyPill mint={card.token.mintAddress} symbol={label} onNeedsPanel={open} />
      <div className="scope-avatar">
        <TokenImage
          url={card.token.imageUrl?.startsWith("https://") ? card.token.imageUrl : null}
          size={96}
          width={48}
          height={48}
          className="scope-img"
          fallback={<span className="scope-img placeholder">{(card.token.symbol ?? "?").slice(0, 2)}</span>}
        />
        {mark && show("result") && (
          <span className={`scope-mark ${badge.tone}`} role="img" title={badge.text} aria-label={badge.text}>
            {mark}
          </span>
        )}
      </div>
      <div className="scope-main">
        <div className="scope-title">
          <button
            type="button"
            className="scope-symbol"
            onClick={open}
            title={`${label}: open the token's chart and details`}
          >
            {label}
          </button>
          {show("tokenName") && card.token.name && card.token.symbol && (
            <span className="scope-name" title={card.token.name}>
              {card.token.name}
            </span>
          )}
        </div>
        <div className="scope-meta">
          {show("time") && <span className="scope-age num">{age}</span>}
          {filter ? (
            <span className="scope-src mine" title={`Caught by your filter “${filter.name}”`}>
              {filter.icon ? <FilterGlyph icon={filter.icon} size={11} /> : <SlidersIcon size={11} />}
            </span>
          ) : null}
          {curated && show("modelPill") && (
            <span className="scope-src model" title={models.join(" + ")}>
              <BrainIcon size={11} />
              <span className="scope-src-text">
                {models.length > 1 ? `${models[0]} +${models.length - 1}` : models[0]}
              </span>
            </span>
          )}
          {high && show("conviction") && (
            <span
              className="scope-src model"
              title="High conviction: the model's top half-percent of moments"
            >
              HC
            </span>
          )}
          {socials.map((l) => (
            <a
              key={l.key}
              className="pill pill-icon pill-social"
              href={l.url}
              target="_blank"
              rel="noreferrer noopener"
              title={`${l.label}: ${l.url.replace(/^https:\/\//, "").replace(/\/$/, "")}`}
              aria-label={`Open the coin's ${l.label}`}
            >
              <l.Icon size={10} />
            </a>
          ))}
        </div>
      </div>
      <div className="scope-figs">
        {show("now") && (
          <div className="scope-fig scope-now">
            <span className="scope-fig-label">MC</span>
            <span className={`num${move === null ? "" : move >= 0 ? " up" : " down"}`}>
              {usd(nowMcap ?? alertMcap)}
            </span>
          </div>
        )}
        {show("alert") && (
          <div className="scope-fig">
            <span className="scope-fig-label">At</span>
            <span className="num">{usd(alertMcap)}</span>
          </div>
        )}
        {show("peak") && peak != null && peak > 0 && (
          <div className="scope-fig">
            <span className="scope-fig-label">Pk</span>
            <span className="num up">+{pct(peak)}</span>
          </div>
        )}
      </div>
      {chips.length > 0 && (
        <div className="scope-chips">
          {chips.map((c) => {
            const tl = tileLook(tiles, c.tone, c.risky);
            return (
              <span
                key={c.key}
                className={`scope-chip ${tl.className ?? ""}`}
                style={tl.style}
                title={c.title}
              >
                <span className="scope-chip-label">{c.label}</span>
                <span className="num">{c.value}</span>
              </span>
            );
          })}
        </div>
      )}
    </article>
  );
}
