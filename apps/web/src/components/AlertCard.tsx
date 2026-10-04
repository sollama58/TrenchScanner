import { useState } from "react";
import type { Card, Outcome } from "../api";
import { ago, change, minutes, multiple, pct, shortAddress, tokenLabel, tokenThumb, usd } from "../format";
import { BrainIcon, CheckIcon, CopyIcon, ExternalIcon, RobotIcon } from "./Icons";

/** The 1-hour win window every alert is graded over. */
const WIN_WINDOW_MIN = 60;

/** What a card's verdict badge says. Words and an icon carry it; color only reinforces. */
export function outcomeBadge(outcome: Outcome | null): { text: string; tone: string } {
  if (!outcome) return { text: "Filter match", tone: "neutral" };
  switch (outcome.status) {
    case "watching":
      return outcome.hit2x
        ? { text: `✓ 2x hit · ${outcome.minutesLeft ?? 0}m left`, tone: "good" }
        : { text: `◷ Live · ${outcome.minutesLeft ?? 0}m left`, tone: "info" };
    case "won":
      return outcome.hitGoal ? { text: "✓✓ 4x win", tone: "good" } : { text: "✓ 2x win", tone: "good" };
    case "disqualified":
      return { text: "✕ Stopped out", tone: "bad" };
    case "missed":
      return { text: "✕ Missed 2x", tone: "bad" };
    default:
      return { text: "Ungraded", tone: "neutral" };
  }
}

/** A filter match's verdict, from the columns the outcome job writes onto the Match row. */
function matchOutcome(card: Card): Outcome | null {
  if (card.kind !== "match" || card.hit2xIn1h === undefined || card.hit2xIn1h === null) return null;
  return {
    status: card.disqualified ? "disqualified" : card.hit2xIn1h ? "won" : "missed",
    hit2x: card.hit2xIn1h,
    hitGoal: card.hit4xIn1h ?? null,
    peak1hReturnPct: null,
    maxDrawdown1hPct: null,
    peak24hReturnPct: null,
    finalized: true,
    minutesLeft: null,
  };
}

const LINKS = [
  { label: "Dex", href: (m: string) => `https://dexscreener.com/solana/${m}` },
  { label: "Pump", href: (m: string) => `https://pump.fun/coin/${m}` },
  { label: "RugCheck", href: (m: string) => `https://rugcheck.xyz/tokens/${m}` },
];

export function AlertCard({
  card,
  now,
  showFilter = false,
  compact = false,
}: {
  card: Card;
  now: number;
  showFilter?: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const s = card.snapshot;
  const alertMcap = s.marketCapUsd;
  const nowMcap = card.currentMarketCapUsd;
  const move = change(alertMcap, nowMcap);
  const curated = card.curated;
  const outcome = curated?.outcome ?? matchOutcome(card);
  const badge = outcomeBadge(outcome);
  const isModel = curated && !curated.source.startsWith("heuristic");
  const peak = curated?.outcome.peak24hReturnPct ?? card.peakReturnPct;
  const ai = curated?.aiReview;
  const mint = card.token.mintAddress;
  const watching = outcome?.status === "watching" && outcome.minutesLeft !== null;
  const elapsedPct = watching ? ((WIN_WINDOW_MIN - outcome.minutesLeft!) / WIN_WINDOW_MIN) * 100 : 0;
  const hasPeak = peak !== null && peak !== undefined && peak > 0;

  const copy = () => {
    void navigator.clipboard?.writeText(mint).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <article className={`card tone-${badge.tone}${compact ? " compact" : ""}`}>
      {watching && (
        <div className="countdown" title={`${outcome.minutesLeft}m left in the 1h win window`}>
          <span style={{ width: `${elapsedPct}%` }} />
        </div>
      )}
      <header className="card-head">
        <div className={`avatar-wrap tone-${badge.tone}`}>
          <TokenAvatar url={card.token.imageUrl} symbol={card.token.symbol} />
        </div>
        <div className="card-title">
          <div className="title-row">
            <strong className="symbol">{tokenLabel(card.token)}</strong>
            {card.token.name && card.token.symbol && <span className="token-name">{card.token.name}</span>}
          </div>
          <div className="meta-row">
            {curated && (
              <span
                className={`pill ${isModel ? "pill-model" : "pill-heur"}`}
                title="Curator confidence, 0-100"
              >
                {isModel && <BrainIcon size={12} />}
                {curated.modelName ?? (isModel ? "Model" : "Heuristic")} · {curated.confidence.toFixed(0)}
              </span>
            )}
            {showFilter && card.kind === "match" && card.filter && (
              <span className="pill">{card.filter.name}</span>
            )}
            <span className="when">{ago(card.matchedAt, now)}</span>
          </div>
        </div>
        <span className={`badge ${badge.tone}`}>{badge.text}</span>
      </header>

      <div className="card-figures">
        <div className="fig">
          <label>Alert</label>
          <span className="num">{usd(alertMcap)}</span>
        </div>
        <div className="fig">
          <label>Now</label>
          <span className="num">{usd(nowMcap)}</span>
          {move !== null && (
            <small className={`num delta ${move >= 0 ? "up" : "down"}`}>
              {move >= 0 ? "▲" : "▼"} {pct(Math.abs(move))}
            </small>
          )}
        </div>
        <div className={`fig peak ${hasPeak && peak >= 100 ? "hot" : ""}`}>
          <label>Peak</label>
          <span className="num">{hasPeak ? multiple(peak) : "–"}</span>
        </div>
      </div>

      {!compact && (
        <dl className="card-stats">
          <div>
            <dt>Liq</dt>
            <dd className="num">{usd(s.liquidityUsd)}</dd>
          </div>
          <div>
            <dt>Vol 24h</dt>
            <dd className="num">{usd(s.volume24hUsd)}</dd>
          </div>
          <div>
            <dt>Holders</dt>
            <dd className="num">{s.holderCount ?? "–"}</dd>
          </div>
          <div>
            <dt>Age</dt>
            <dd className="num">{minutes(s.ageMinutes)}</dd>
          </div>
          <div>
            <dt>Top 10</dt>
            <dd className="num">{pct(s.top10HolderPct)}</dd>
          </div>
          <div>
            <dt>Dev</dt>
            <dd className="num">{pct(s.devWalletPct, 1)}</dd>
          </div>
          <div>
            <dt>Snipers</dt>
            <dd className="num">{pct(s.freshTop10WalletPct)}</dd>
          </div>
          <div>
            <dt>Risk</dt>
            <dd className="num">{s.riskScore ?? "–"}</dd>
          </div>
        </dl>
      )}

      {curated && curated.reasons.length > 0 && (
        <ul className="reasons">
          {curated.reasons.slice(0, compact ? 2 : 4).map((r) => (
            <li key={r}>{r.replace(/^model signal: /, "")}</li>
          ))}
        </ul>
      )}

      {ai && (
        <div
          className={`ai-review ${ai.decision === "buy" ? "buy" : ai.decision === "no_buy" ? "nobuy" : ""}`}
        >
          <button className="ai-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <RobotIcon size={14} />
            <span>
              AI reviewer:{" "}
              <strong>{ai.decision === "buy" ? "BUY" : ai.decision === "no_buy" ? "NO BUY" : "error"}</strong>
              {ai.probability2x !== null && (
                <span className="muted"> · {(ai.probability2x * 100).toFixed(0)}% to 2x</span>
              )}
            </span>
            <span className="chev">{open ? "▴" : "▾"}</span>
          </button>
          {open && (
            <div className="ai-body">
              {ai.reasoning && <p>{ai.reasoning}</p>}
              {ai.risks.length > 0 && <p className="muted">Risks: {ai.risks.join("; ")}</p>}
              {ai.error && <p className="muted">Error: {ai.error}</p>}
              <p className="faint">Visible to admin wallets only · {ai.mode} mode</p>
            </div>
          )}
        </div>
      )}

      <footer className="card-foot">
        <button className="mint" onClick={copy} title="Copy mint address">
          {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
          {copied ? "Copied" : shortAddress(mint)}
        </button>
        <nav className="card-links">
          {LINKS.map((l) => (
            <a key={l.label} href={l.href(mint)} target="_blank" rel="noreferrer">
              {l.label}
              <ExternalIcon size={11} />
            </a>
          ))}
        </nav>
      </footer>
    </article>
  );
}

/** The token's image as a small thumbnail, falling back to the original URL, then to its initials. */
function TokenAvatar({ url, symbol }: { url: string | null; symbol: string | null }) {
  // 0: thumbnail, 1: original URL, 2: give up.
  const [attempt, setAttempt] = useState(0);
  const thumb = url ? tokenThumb(url) : null;
  const src = !url?.startsWith("https://")
    ? null
    : attempt === 0
      ? thumb
      : attempt === 1 && thumb !== url
        ? url
        : null;
  if (!src) return <span className="avatar placeholder">{(symbol ?? "?").slice(0, 2)}</span>;
  return (
    // Launcher-supplied URL: https only, and no referrer sent to whoever hosts it.
    <img
      className="avatar"
      src={src}
      alt=""
      width={40}
      height={40}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setAttempt((a) => a + 1)}
    />
  );
}
