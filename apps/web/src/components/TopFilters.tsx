import { useEffect, useRef, useState } from "react";
import { post, ApiError, type FilterBoard, type FilterBoardEntry } from "../api";
import { invalidate } from "../cache";
import { usePolling, type Loadable } from "../hooks";
import { pct } from "../format";
import { criteriaLines, MIN_SCORE_LABEL } from "../filterFields";
import { ScoreExplainer } from "./ScoreExplainer";
import { ScoreBar } from "./ScoreBar";
import { ArrowRightIcon, CloseIcon, CopyIcon, TrophyIcon } from "./Icons";
import { Skeleton } from "./Charts";
import { intervalText, isEarly, MIN_GRADED_FOR_RATE, wilsonOfRate } from "../rates";

/** Green only on a meaningful sample: below the floor a rate is greyed, whatever it reads. */
function filterRateTone(rate: number | null, target: number, graded: number): string {
  if (rate === null) return "";
  if (isEarly(graded)) return "rate-early";
  return rate >= target ? "up" : "";
}

/** The board's current #1: the best-scoring ranked filter, or null while nothing ranks yet. */
export function topFilter(board: FilterBoard | null): FilterBoardEntry | null {
  return board?.ranked[0] ?? null;
}

/**
 * The public filter leaderboard's way in: a "Top filters" subsection under Build a filter on the
 * Filters tab, with a short explainer, a one-click copy of the current #1 into the reader's own
 * saved filters, and a button that opens the whole board in a popup (TopFiltersModal). `onCopied`
 * lets the tab reload its list so a copy shows up straight away.
 */
export function TopFiltersPick({ onCopied }: { onCopied: () => void }) {
  const board = usePolling<FilterBoard>("/filters/leaderboard", 300_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  // Old #top links land on the Filters tab; open the board for them.
  const [open, setOpen] = useState(() => window.location.hash === "#top");

  const copy = async (e: FilterBoardEntry) => {
    setBusy(e.id);
    setMessage(null);
    try {
      await post(`/filters/leaderboard/${e.id}/copy`);
      invalidate("/filters");
      onCopied();
      setMessage({ text: `Copied “${e.name}” to your filters. It's saved but not active yet.`, ok: true });
    } catch (err) {
      setMessage({
        text: err instanceof ApiError || err instanceof Error ? err.message : String(err),
        ok: false,
      });
    } finally {
      setBusy(null);
    }
  };

  const data = board.data;
  const top = topFilter(data);
  return (
    <div className="top-pick" id="top-filters">
      <h4 className="row gap-xs">
        <TrophyIcon size={15} /> Top filters
      </h4>
      <p className="muted small">
        Filters other traders share, ranked by how their alerts have done. Copy one to start from settings
        that are already working, then tweak it.
      </p>
      {top ? (
        <div className="top-pick-card">
          <span className="board-rank num">1</span>
          <div className="board-main">
            <div className="row gap-xs wrap">
              <strong>{top.name}</strong>
              <span className="faint small">#{top.tag}</span>
              {top.mine && <span className="pill pill-mine">Yours</span>}
            </div>
            <p className="small muted board-stats">
              Score <strong className="num">{top.score ?? "–"}</strong> ·{" "}
              <strong className="num">{pct(top.winRatePct)}</strong> 2x ·{" "}
              {top.catch && top.catch.runners > 0 && (
                <>
                  <strong className="num">{pct(top.catch.pct)}</strong> catch ·{" "}
                </>
              )}
              {top.graded.toLocaleString()} graded
            </p>
          </div>
          <button
            className="primary"
            onClick={() => void copy(top)}
            disabled={busy !== null}
            title="Save the #1 filter's settings as a new filter of yours"
            aria-label={`Copy the top filter, ${top.name}, to your filters`}
          >
            <CopyIcon size={15} /> {busy === top.id ? "Copying…" : "Copy #1"}
          </button>
        </div>
      ) : (
        <p className="small faint">
          {board.error && !data
            ? `Couldn't load the leaderboard: ${board.error.message}`
            : !data
              ? "Loading the leaderboard…"
              : data.sharedCount === 0
                ? "No one has shared a filter yet."
                : `No shared filter has ${data.minGradedToRank} graded alerts yet.`}
        </p>
      )}
      {message && !open && <p className={message.ok ? "notice" : "error"}>{message.text}</p>}
      <button type="button" className="ghost top-pick-open" onClick={() => setOpen(true)}>
        See the leaderboard <ArrowRightIcon size={13} />
      </button>
      <TopFiltersModal
        open={open}
        onClose={() => setOpen(false)}
        board={board}
        busy={busy}
        message={message}
        onCopy={(e) => void copy(e)}
      />
    </div>
  );
}

/**
 * The whole filter leaderboard in a native modal dialog (a centered panel on desktop, a sheet from
 * the bottom on phones): filters their owners chose to share, ranked by how far their graded
 * alerts have proven themselves toward the 75% / 50% targets (the model score), each with a copy.
 */
function TopFiltersModal({
  open,
  onClose,
  board,
  busy,
  message,
  onCopy,
}: {
  open: boolean;
  onClose: () => void;
  board: Loadable<FilterBoard>;
  busy: string | null;
  message: { text: string; ok: boolean } | null;
  onCopy: (e: FilterBoardEntry) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const data = board.data;
  return (
    <dialog
      ref={ref}
      className="about-modal sheet-modal filter-board-modal"
      aria-labelledby="top-filters-title"
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself; clicks inside land on its content.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="about-body">
        <header className="about-head">
          <div>
            <span className="eyebrow">Top filters</span>
            <h2 id="top-filters-title">Filters ranked by their alerts</h2>
          </div>
          <button className="ghost icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </header>
        {open && (
          <>
            <p className="muted">
              Filters their owners chose to share, scored 0-100 the same way as the models: 50 points for the
              proven 2x rate, 30 for the 4x rate, 10 for the 10x rate (targets{" "}
              {data
                ? `${data.targets.hitRate2xPct}% / ${data.targets.hitRate4xPct}% / ${data.targets.tenXPct ?? 25}%`
                : "75% / 50% / 25%"}
              ), and 10 for run size, how far the calls ran over their 24h watch (target a{" "}
              {data ? 2 ** data.targets.runDoublings : 4}x average, capped at 100x). A win is 2x on the alert
              price within 15 minutes (4x within 30, 10x within an hour) before a 50% drop.
            </p>
            {data && (
              <p className="muted small">
                Each record covers the last {data.windowDays} days since the filter's settings last changed,
                and a filter needs {data.minGradedToRank} graded alerts to rank. Owners' wallets are never
                shown. Share one of yours from its settings in Your saved filters.
              </p>
            )}
            {message && <p className={message.ok ? "notice" : "error"}>{message.text}</p>}
            {board.error && !data && (
              <p className="error">Couldn't load the leaderboard: {board.error.message}</p>
            )}
            {!data && !board.error && <Skeleton height={220} />}
            {data && data.ranked.length === 0 && (
              <div className="empty-state">
                <TrophyIcon size={28} />
                <p>
                  {data.sharedCount === 0
                    ? "No one has shared a filter yet. Turn on “Share on the filter leaderboard” in one of yours to be first."
                    : `No shared filter has ${data.minGradedToRank} graded alerts yet. They rank as soon as they do.`}
                </p>
              </div>
            )}
            {data && data.ranked.length > 0 && (
              <ol className="filter-board">
                {data.ranked.map((e) => (
                  <BoardEntry key={e.id} entry={e} busy={busy} onCopy={onCopy} targets={data.targets} />
                ))}
              </ol>
            )}

            {data && data.warmingUp.length > 0 && (
              <details className="board-warming">
                <summary>
                  <strong>Warming up</strong>{" "}
                  <span className="muted small">
                    shared filters with fewer than {data.minGradedToRank} graded alerts (
                    {data.warmingUp.length})
                  </span>
                </summary>
                <ol className="filter-board">
                  {data.warmingUp.map((e) => (
                    <BoardEntry key={e.id} entry={e} busy={busy} onCopy={onCopy} targets={data.targets} />
                  ))}
                </ol>
              </details>
            )}
          </>
        )}
      </div>
    </dialog>
  );
}

function BoardEntry({
  entry: e,
  busy,
  onCopy,
  targets,
}: {
  entry: FilterBoardEntry;
  busy: string | null;
  onCopy: (e: FilterBoardEntry) => void;
  targets: FilterBoard["targets"];
}) {
  const since = new Date(e.recordSince).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    <li className={`board-entry ${e.mine ? "mine" : ""}`}>
      <div className="board-rank num">{e.rank ?? "–"}</div>
      <div className="board-main">
        <div className="row gap-xs wrap">
          <strong>{e.name}</strong>
          <span className="faint small">#{e.tag}</span>
          {e.mine && <span className="pill pill-mine">Yours</span>}
          {e.retired ? (
            <span
              className="pill"
              title="Its owner deleted it; it stays here for its record and can still be copied"
            >
              Retired
            </span>
          ) : (
            !e.isActive && (
              <span className="pill" title="Its owner has switched this filter off, so it isn't alerting now">
                Paused
              </span>
            )
          )}
        </div>
        <ScoreBar
          score={e.score}
          band={e.band}
          title={
            e.proven2xPct === null
              ? "No graded alerts yet"
              : `Proven 2x ${e.proven2xPct}% · 4x ${e.proven4xPct}% · run ${e.provenRunDoublings} doublings`
          }
        />
        <p className="small muted board-stats">
          <strong
            className={`num ${filterRateTone(e.winRatePct, targets.hitRate2xPct, e.graded)}`}
            title={`${intervalText(wilsonOfRate(e.winRatePct, e.graded))}${
              isEarly(e.graded) ? ` · early: under ${MIN_GRADED_FOR_RATE} graded alerts` : ""
            }`}
          >
            {pct(e.winRatePct)}
          </strong>{" "}
          2x ·{" "}
          <strong className={`num ${filterRateTone(e.goalRatePct, targets.hitRate4xPct, e.graded)}`}>
            {pct(e.goalRatePct)}
          </strong>{" "}
          4x ·{" "}
          {e.tenXRatePct != null && (
            <>
              <strong className="num">{pct(e.tenXRatePct)}</strong> 10x ·{" "}
            </>
          )}
          <span title="How far the alerts ran on average over their 24h watch (stopped-out calls count as 0)">
            runs avg <strong className="num">{runMultiple(e.avgRunDoublings)}</strong>
          </span>{" "}
          {e.catch && e.catch.runners > 0 && (
            <>
              ·{" "}
              <span
                title={`Catch: it alerted on ${e.catch.caught.toLocaleString()} of the ${e.catch.runners.toLocaleString()} coins that doubled since ${since}, at a moment that went on to double`}
              >
                catch <strong className="num">{pct(e.catch.pct)}</strong>
              </span>{" "}
            </>
          )}
          · {e.graded.toLocaleString()} graded since {since}
        </p>
        <details className="board-criteria">
          <summary className="small">Settings</summary>
          <ul className="small muted">
            {criteriaLines(e.criteria).map((line) => (
              <li key={line}>
                {line}
                {line.startsWith(MIN_SCORE_LABEL) && <ScoreExplainer />}
              </li>
            ))}
          </ul>
        </details>
      </div>
      <div className="board-actions">
        <button
          onClick={() => onCopy(e)}
          disabled={busy !== null}
          title="Save these settings as a new filter of yours"
          aria-label={`Copy ${e.name} to your filters`}
        >
          <CopyIcon size={15} /> {busy === e.id ? "Copying…" : "Copy"}
        </button>
      </div>
    </li>
  );
}

/** Average run size in doublings as a multiple, e.g. 1.5 doublings -> "2.8x". */
function runMultiple(doublings: number | null): string {
  if (doublings === null) return "–";
  return `${(2 ** doublings).toFixed(1)}x`;
}
