import type { Match } from "../api/types";
import { fmtUsd, fmtPct, fmtAge } from "../utils/format";

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
        {match.peakMcapUsd !== null && snapshot.marketCapUsd > 0 && (
          <div>
            <dt>Peak since</dt>
            <dd title="Highest market cap seen since this match, updated daily">
              {fmtUsd(match.peakMcapUsd)} ({(match.peakMcapUsd / snapshot.marketCapUsd).toFixed(1)}x)
            </dd>
          </div>
        )}
      </dl>

      <ScoreBreakdown snapshot={snapshot} />

      <div className="token-card__mint">{token.mintAddress}</div>
    </a>
  );
}

/** Why the token scored the way it did - the 4 components behind the single number in the header. */
function ScoreBreakdown({
  snapshot,
}: {
  snapshot: {
    scoreMomentum: number | null;
    scoreHolderHealth: number | null;
    scoreAge: number | null;
    scoreNarrative: number | null;
  };
}) {
  const bars: { label: string; title: string; value: number | null }[] = [
    { label: "Mom", title: "Momentum (volume/mcap ratio, buy pressure)", value: snapshot.scoreMomentum },
    { label: "Hold", title: "Holder health (growth, concentration)", value: snapshot.scoreHolderHealth },
    { label: "Age", title: "Age (sweet spot vs. too new/too mature)", value: snapshot.scoreAge },
    { label: "Narr", title: "Narrative (theme + social presence)", value: snapshot.scoreNarrative },
  ];

  // Older snapshots (pre-breakdown-tracking) won't have these - skip the row entirely rather
  // than show four empty bars.
  if (bars.every((b) => b.value === null)) return null;

  return (
    <div className="token-card__breakdown">
      {bars.map((bar) => (
        <div
          key={bar.label}
          className="breakdown-bar"
          title={`${bar.title}: ${bar.value?.toFixed(0) ?? "—"}`}
        >
          <span className="breakdown-bar__label">{bar.label}</span>
          <span className="breakdown-bar__track">
            <span
              className="breakdown-bar__fill"
              style={{ width: `${Math.max(0, Math.min(100, bar.value ?? 0))}%` }}
            />
          </span>
        </div>
      ))}
    </div>
  );
}

function scoreTier(score: number): "high" | "mid" | "low" {
  if (score >= 70) return "high";
  if (score >= 45) return "mid";
  return "low";
}
