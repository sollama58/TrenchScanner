import { useEffect, useRef, useState } from "react";
import { put, type Leaderboard, type LeaderboardEntry } from "../api";
import { invalidate } from "../cache";

/**
 * Saves the combined feed's settings (which models' calls it shows, and whether it shows model
 * calls at all) to the user's account. The Live tab's checkboxes and the Models tab's both go
 * through here, so the two always show the same list.
 */
export async function saveFeedSettings(change: {
  models?: string[] | null;
  showModelAlerts?: boolean;
  /** Follow the default (the top models); ticking models by hand turns it off. */
  followBest?: boolean;
}) {
  await put("/curated/feed", change);
  // Every cached feed and leaderboard answer was for the old settings. Stats and insights don't
  // depend on them, so they stay cached (the Models tab keeps painting at once).
  invalidate("/curated/models");
  invalidate("/matches");
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/** The next checked list after ticking or unticking `id`, in leaderboard order. */
export function toggledModels(board: Leaderboard, id: string): string[] {
  const checked = new Set(board.selectedModels);
  if (checked.has(id)) checked.delete(id);
  else checked.add(id);
  return board.entries.filter((e) => checked.has(e.id)).map((e) => e.id);
}

/**
 * The dropdown's order: models ranked on the last 24h (enough graded calls) by 2x rate, best
 * first, the way the top models are picked; then the rest, longest record first.
 */
export function byLast24h(entries: readonly LeaderboardEntry[]): LeaderboardEntry[] {
  const rate = (e: LeaderboardEntry) => e.last24h?.hitRate2xPct ?? -1;
  const graded = (e: LeaderboardEntry) => e.last24h?.graded ?? 0;
  const ranked = (e: LeaderboardEntry) => e.last24h?.qualifies === true;
  return [...entries].sort(
    (a, b) =>
      Number(ranked(b)) - Number(ranked(a)) ||
      (ranked(a) ? rate(b) - rate(a) : 0) ||
      graded(b) - graded(a) ||
      a.rank - b.rank,
  );
}

/**
 * Picks whose calls the combined feed shows, as checkboxes. Names and order come straight from
 * the leaderboard, so a model is called the same thing here as on the Models tab, and evolved
 * models appear under their new names. At least one stays checked; turning model alerts off
 * altogether is the switch beside this.
 */
export function ModelPicker({
  board,
  disabled = false,
  onChanged,
}: {
  board: Leaderboard;
  disabled?: boolean;
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Shown at once while the save is in flight.
  const [pending, setPending] = useState<string[] | null>(null);
  const ref = useRef<HTMLDetailsElement>(null);
  const checked = new Set(pending ?? board.selectedModels);
  const names = board.entries.filter((e) => checked.has(e.id)).map((e) => e.name);

  useEffect(() => {
    // Closes the list on a click anywhere else.
    const onClick = (e: MouseEvent) => {
      if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false;
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  // The optimistic selection stands until a board that agrees with it arrives: a poll that
  // started before the save and lands after it must not snap the boxes back meanwhile.
  useEffect(() => {
    setPending((p) => (p && !sameSet(p, board.selectedModels) ? p : null));
  }, [board]);

  const save = async (models: string[] | null) => {
    setSaving(true);
    setError(null);
    // Following the default shows the current top models at once rather than an empty list.
    setPending(models ?? board.defaultModels ?? [board.defaultModel]);
    try {
      await saveFeedSettings({ models });
      onChanged();
    } catch (e) {
      setPending(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // Older API builds carry no 24h records: the list falls back to the 30-day board score.
  const daily = board.entries.some((e) => e.last24h !== undefined);
  const rows = daily ? byLast24h(board.entries) : board.entries;
  const minGraded = board.defaultRule?.minGraded ?? 30;
  // Bars are drawn against the best ranked 2x rate, so the spread between models shows. A model
  // without enough calls to rank gets no bar: its rate is too thin to compare.
  const scaleTop = Math.max(
    1,
    ...rows.map((e) => (e.last24h?.qualifies ? (e.last24h.hitRate2xPct ?? 0) : 0)),
  );

  const following = board.followBest === true && pending === null;
  const summary = following
    ? names.length > 1
      ? `Top ${names.length}: ${names.join(", ")}`
      : `Best: ${names[0] ?? "–"}`
    : names.length === 0
      ? "–"
      : names.length <= 2
        ? names.join(", ")
        : `${names[0]} +${names.length - 1}`;

  return (
    <div className={`model-picker${disabled ? " off" : ""}`}>
      <span className="eyebrow">Models</span>
      <details className="checklist" ref={ref}>
        <summary aria-label="Which models' calls to show" aria-disabled={disabled}>
          <span className="checklist-summary">{summary}</span>
          <span className="chev">▾</span>
        </summary>
        <div className="checklist-menu" role="group" aria-label="Models in your feed">
          {following && (
            <p className="faint small checklist-note">
              Following the top models. Ticking a model switches to your own picks.
            </p>
          )}
          {daily ? (
            <div className="mp-head" aria-hidden>
              <span>Last 24h</span>
              <span>2x rate</span>
              <span>Avg return</span>
            </div>
          ) : null}
          {rows.map((e, i) => {
            const on = checked.has(e.id);
            const last = on && checked.size === 1;
            const day = e.last24h ?? null;
            const ranked = daily && day?.qualifies === true;
            const rate = day?.hitRate2xPct ?? null;
            const ret = day?.avgReturnPct ?? null;
            return (
              <label
                key={e.id}
                className={`checklist-row mp-row${on ? " on" : ""}${daily && !ranked ? " unranked" : ""}`}
                title={e.description}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={disabled || saving || last}
                  onChange={() => void save(toggledModels({ ...board, selectedModels: [...checked] }, e.id))}
                />
                {daily ? (
                  <>
                    <span className="mp-main">
                      <span className="checklist-name">
                        <span
                          className={`mp-rank num${e.isDefault ? " top" : ""}`}
                          title={e.isDefault ? "One of the top models: the default feed" : undefined}
                        >
                          {ranked ? i + 1 : "–"}
                        </span>
                        <span className="mp-name">{e.name}</span>
                        {e.isBest && (
                          <span className="mp-badge best" title="Highest average return over the last 24h">
                            ★<span className="mp-word"> best</span>
                          </span>
                        )}
                      </span>
                      <span className="mp-bar" aria-hidden>
                        <span
                          className={`mp-fill${e.isDefault ? " top" : ""}`}
                          style={{
                            width: `${rate === null || !ranked ? 0 : Math.max(3, (rate / scaleTop) * 100)}%`,
                          }}
                        />
                      </span>
                      <span className="mp-sub">
                        {day === null || day.graded === 0
                          ? "no graded calls today"
                          : ranked
                            ? `${day.graded} graded calls`
                            : `${day.graded} of ${minGraded} calls to rank`}
                      </span>
                    </span>
                    <span className="mp-rate num">{rate === null ? "–" : `${rate.toFixed(0)}%`}</span>
                    <span className={`mp-ret num ${ret === null ? "" : ret >= 0 ? "up" : "down"}`}>
                      {ret === null ? "–" : `${ret >= 0 ? "+" : ""}${ret.toFixed(1)}%`}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="checklist-name">
                      <span className="faint num">#{e.rank}</span> {e.name}
                      {e.isBest && <span className="chip chip-model">best</span>}
                      {e.isDefault && <span className="chip">top</span>}
                    </span>
                    <span className="num muted">
                      {e.composite.score === null ? "–" : e.composite.score.toFixed(0)}
                    </span>
                  </>
                )}
              </label>
            );
          })}
          {daily && (
            <p className="mp-foot faint small">
              <span className="mp-rank top mp-key">1</span> The top {board.defaultRule?.count ?? 3} by score
              make up the default feed. <span className="mp-badge best">★ best</span> has the highest average
              return under the exit plan. Both need {minGraded} graded calls in the last 24h; picked every{" "}
              {Math.round((board.defaultRule?.refreshMinutes ?? 360) / 60)} hours (00, 06, 12 and 18 UTC).
            </p>
          )}
          {board.followBest === false && (
            <button className="ghost small-btn" disabled={disabled || saving} onClick={() => void save(null)}>
              Follow the top models
            </button>
          )}
        </div>
      </details>
      {error && <small className="error">{error}</small>}
    </div>
  );
}
