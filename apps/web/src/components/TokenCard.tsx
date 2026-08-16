import type { Match } from "../api/types";

function fmtUsd(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

function fmtPct(n: number | null): string {
  return n === null ? "—" : `${n.toFixed(1)}%`;
}

function fmtAge(minutes: number | null): string {
  if (minutes === null) return "—";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

export function TokenCard({ match }: { match: Match }) {
  const { token, snapshot } = match;
  const name = token.name ?? token.symbol ?? token.mintAddress.slice(0, 8);
  const dexUrl = `https://dexscreener.com/solana/${token.pairAddress ?? token.mintAddress}`;

  return (
    <a className="token-card" href={dexUrl} target="_blank" rel="noreferrer">
      <div className="token-card__header">
        <div>
          <span className="token-card__name">{name}</span>
          {token.symbol && <span className="token-card__symbol">${token.symbol}</span>}
        </div>
        <span className="token-card__score" data-tier={scoreTier(match.score)}>
          {match.score.toFixed(0)}
        </span>
      </div>

      <div className="token-card__tags">
        {token.narrativeTags.map((tag) => (
          <span key={tag} className="tag">
            {tag}
          </span>
        ))}
        {token.hasTwitter && <span className="tag tag--muted">𝕏</span>}
        {token.hasTelegram && <span className="tag tag--muted">TG</span>}
      </div>

      <dl className="token-card__stats">
        <div>
          <dt>Market cap</dt>
          <dd>{fmtUsd(snapshot.marketCapUsd)}</dd>
        </div>
        <div>
          <dt>24h volume</dt>
          <dd>{fmtUsd(snapshot.volume24hUsd)}</dd>
        </div>
        <div>
          <dt>Holders</dt>
          <dd>{snapshot.holderCount ?? "—"}</dd>
        </div>
        <div>
          <dt>Top 10</dt>
          <dd>{fmtPct(snapshot.top10HolderPct)}</dd>
        </div>
        <div>
          <dt>Age</dt>
          <dd>{fmtAge(snapshot.ageMinutes)}</dd>
        </div>
        <div>
          <dt>Matched</dt>
          <dd>{new Date(match.matchedAt).toLocaleTimeString()}</dd>
        </div>
      </dl>

      <div className="token-card__mint">{token.mintAddress}</div>
    </a>
  );
}

function scoreTier(score: number): "high" | "mid" | "low" {
  if (score >= 70) return "high";
  if (score >= 45) return "mid";
  return "low";
}
