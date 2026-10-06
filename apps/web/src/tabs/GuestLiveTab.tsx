import { useMemo, useState } from "react";
import type { MatchPage } from "../api";
import { AlertCard } from "../components/AlertCard";
import { SkeletonCards } from "../components/Charts";
import { AboutModal } from "../components/AboutModal";
import { ChartIcon, InfoIcon, LockIcon, PaletteIcon, RadarIcon } from "../components/Icons";
import { prefetch } from "../cache";
import { usePolling, useNow } from "../hooks";
import { cardHideSet, feedGridProps, useAppearance } from "../appearance";

/** GET /guest/feed: the default model's calls, as feed cards, plus which model that is. */
export interface GuestPage extends MatchPage {
  model: { id: string; name: string };
}

/** The API serves guests this many pages; older history is for signed-in readers. */
const GUEST_MAX_PAGES = 5;

const TARGETS = { hitRate2xPct: 75, hitRate4xPct: 50 };

/**
 * The Live tab for a visitor without a wallet: the recommended model's calls from the read-only
 * guest endpoint. Everything that is saved to a wallet (model picks, the model-alerts switch,
 * feed stats, the look of the feed) shows greyed out with a prompt to connect one, and nothing
 * here calls a route that needs a session, so a guest sees no errors.
 */
export function GuestLiveTab({ onConnect }: { onConnect: () => void }) {
  const now = useNow(15_000);
  const [page, setPage] = useState(1);
  const [aboutOpen, setAboutOpen] = useState(false);
  const look = useAppearance();
  const hidden = useMemo(() => cardHideSet(look), [look]);
  const feedPath = (n: number) => `/guest/feed?page=${n}`;
  const feed = usePolling<GuestPage>(feedPath(page), 30_000);
  const data = feed.data;
  const hasMore = (data?.hasMore ?? false) && page < GUEST_MAX_PAGES;
  const modelName = data?.model.name ?? "the recommended model";
  const lockTitle = "Connect a wallet to use this";

  return (
    <div className="stack">
      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} targets={TARGETS} />
      <div className="guest-banner panel" role="note">
        <LockIcon size={16} />
        <p>
          <strong>You&apos;re browsing as a guest.</strong>{" "}
          <span className="muted">
            You see calls from {data ? <strong>{modelName}</strong> : "the recommended model"}
            {data && ", the recommended model"}. Connect a wallet for your own filters, model picks, alerts
            and stats.
          </span>
        </p>
        <button className="button primary" onClick={onConnect}>
          Connect wallet
        </button>
      </div>
      <section className="panel feed">
        <header className="section-head">
          <div>
            <span className="eyebrow">Live feed</span>
            <div className="heading-row">
              <h2>Calls from {modelName}</h2>
              <button
                type="button"
                className="ghost icon-btn"
                onClick={() => setAboutOpen(true)}
                aria-label="How this works"
                title="How this works"
              >
                <InfoIcon size={16} />
              </button>
            </div>
          </div>
          <div className="feed-controls">
            <button type="button" className="ghost stats-btn" disabled title={lockTitle}>
              <ChartIcon size={14} />
              Stats
            </button>
            <button type="button" className="ghost stats-btn" disabled title={lockTitle}>
              <PaletteIcon size={14} />
              Customize
            </button>
            <button type="button" role="switch" aria-checked className="switch on" disabled title={lockTitle}>
              <span className="switch-track">
                <span className="switch-thumb" />
              </span>
              Model alerts
            </button>
            <button type="button" className="ghost stats-btn" disabled title={lockTitle}>
              <LockIcon size={13} />
              {data ? data.model.name : "Model"}
            </button>
            <span className="live-dot">Polling</span>
          </div>
        </header>
        {feed.error && !data && <p className="error">Couldn&apos;t load the feed: {feed.error.message}</p>}
        {!data && !feed.error && <SkeletonCards count={4} />}
        {data && data.matches.length === 0 && page === 1 && (
          <div className="empty-state">
            <RadarIcon size={28} />
            <p>Nothing from {modelName} yet. Calls land here as they come in.</p>
          </div>
        )}
        <div className={`cards${feed.stale ? " stale" : ""}`} aria-busy={feed.stale} {...feedGridProps(look)}>
          {data?.matches.map((card) => (
            <AlertCard key={card.id} card={card} now={now} labelSource hide={hidden} />
          ))}
        </div>
        {data && data.matches.length === 0 && page > 1 && (
          <p className="muted small center">Nothing older here.</p>
        )}
        {(page > 1 || hasMore) && (
          <nav className="pager">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              ← Newer
            </button>
            <span className="muted small num">Page {page}</span>
            <button
              disabled={!hasMore || feed.stale}
              onPointerEnter={() => prefetch(feedPath(page + 1))}
              onFocus={() => prefetch(feedPath(page + 1))}
              onClick={() => setPage((p) => p + 1)}
            >
              Older →
            </button>
          </nav>
        )}
        {page >= GUEST_MAX_PAGES && (
          <p className="muted small center">Connect a wallet to see older calls.</p>
        )}
      </section>
    </div>
  );
}
