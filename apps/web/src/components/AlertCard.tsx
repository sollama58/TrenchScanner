import { useState } from "react";
import type { Card, Outcome } from "../api";
import { ago, change, minutes, multiple, pct, shortAddress, tokenLabel, usd } from "../format";

/** What a card's verdict badge says. Words and an icon carry it; color only reinforces. */
export function outcomeBadge(outcome: Outcome | null): { text: string; tone: string } {
  if (!outcome) return { text: "Filter match", tone: "neutral" };
  switch (outcome.status) {
    case "watching":
      return outcome.hit2x
        ? { text: `✓ 2x hit · ${outcome.minutesLeft ?? 0}m left`, tone: "good" }
        : { text: `◷ Watching · ${outcome.minutesLeft ?? 0}m left`, tone: "info" };
    case "won":
      return outcome.hitGoal ? { text: "✓✓ 4x win", tone: "good" } : { text: "✓ 2x win", tone: "good" };
    case "disqualified":
      return { text: "✕ Stopped out first", tone: "bad" };
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

export function AlertCard({
  card,
  now,
  showFilter = false,
}: {
  card: Card;
  now: number;
  showFilter?: boolean;
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

  const copy = () => {
    void navigator.clipboard?.writeText(mint).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <article className={`card tone-${badge.tone}`}>
      <header className="card-head">
        {card.token.imageUrl ? (
          <img className="avatar" src={card.token.imageUrl} alt="" loading="lazy" />
        ) : (
          <span className="avatar placeholder">{(card.token.symbol ?? "?").slice(0, 2)}</span>
        )}
        <div className="card-title">
          <div className="row gap-s">
            <strong>{tokenLabel(card.token)}</strong>
            {curated && (
              <span className={`chip ${isModel ? "chip-model" : "chip-heur"}`}>
                {isModel ? "Model pick" : "Heuristic pick"} · {curated.confidence.toFixed(0)}
              </span>
            )}
            {showFilter && card.kind === "match" && card.filter && (
              <span className="chip">{card.filter.name}</span>
            )}
          </div>
          <button className="mint" onClick={copy} title="Copy mint address">
            {copied ? "copied" : shortAddress(mint)} · {ago(card.matchedAt, now)}
          </button>
        </div>
        <span className={`badge ${badge.tone}`}>{badge.text}</span>
      </header>

      <div className="card-figures">
        <div>
          <label>At alert</label>
          <span className="num">{usd(alertMcap)}</span>
        </div>
        <div>
          <label>Now</label>
          <span className="num">
            {usd(nowMcap)}{" "}
            {move !== null && (
              <small className={move >= 0 ? "up" : "down"}>
                {move >= 0 ? "▲" : "▼"} {pct(Math.abs(move))}
              </small>
            )}
          </span>
        </div>
        <div>
          <label>Peak</label>
          <span className="num">
            {peak !== null && peak !== undefined && peak > 0 ? multiple(peak) : "–"}
          </span>
        </div>
      </div>

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
          <dt>Top 10</dt>
          <dd className="num">{pct(s.top10HolderPct)}</dd>
        </div>
        <div>
          <dt>Dev</dt>
          <dd className="num">{pct(s.devWalletPct, 1)}</dd>
        </div>
        <div>
          <dt>Fresh top10</dt>
          <dd className="num">{pct(s.freshTop10WalletPct)}</dd>
        </div>
        <div>
          <dt>Risk</dt>
          <dd className="num">{s.riskScore ?? "–"}</dd>
        </div>
        <div>
          <dt>Age</dt>
          <dd className="num">{minutes(s.ageMinutes)}</dd>
        </div>
      </dl>

      {curated && curated.reasons.length > 0 && (
        <ul className="reasons">
          {curated.reasons.slice(0, 4).map((r) => (
            <li key={r}>{r.replace(/^model signal: /, "")}</li>
          ))}
        </ul>
      )}

      {ai && (
        <div className="ai-review">
          <button className="link" onClick={() => setOpen((o) => !o)}>
            AI reviewer ({ai.mode}):{" "}
            <strong>{ai.decision === "buy" ? "BUY" : ai.decision === "no_buy" ? "NO BUY" : "error"}</strong>
            {ai.probability2x !== null && ` · ${(ai.probability2x * 100).toFixed(0)}% to 2x`}{" "}
            {open ? "▴" : "▾"}
          </button>
          {open && (
            <div className="ai-body">
              {ai.reasoning && <p>{ai.reasoning}</p>}
              {ai.risks.length > 0 && <p className="muted">Risks: {ai.risks.join("; ")}</p>}
              {ai.error && <p className="muted">Error: {ai.error}</p>}
              <p className="faint">Admin only</p>
            </div>
          )}
        </div>
      )}

      <footer className="card-links">
        <a href={`https://dexscreener.com/solana/${mint}`} target="_blank" rel="noreferrer">
          DexScreener
        </a>
        <a href={`https://pump.fun/coin/${mint}`} target="_blank" rel="noreferrer">
          Pump.fun
        </a>
        <a href={`https://solscan.io/token/${mint}`} target="_blank" rel="noreferrer">
          Solscan
        </a>
        <a href={`https://rugcheck.xyz/tokens/${mint}`} target="_blank" rel="noreferrer">
          RugCheck
        </a>
      </footer>
    </article>
  );
}
