import { useEffect, useRef, useState } from "react";
import { put, type Leaderboard } from "../api";
import { invalidate } from "../cache";

/**
 * Saves the combined feed's settings (which models' calls it shows, and whether it shows model
 * calls at all) to the user's account. The Live tab's checkboxes and the Models tab's both go
 * through here, so the two always show the same list.
 */
export async function saveFeedSettings(change: {
  models?: string[] | null;
  showModelAlerts?: boolean;
  /** Follow the best performer; ticking models by hand turns it off. */
  followBest?: boolean;
}) {
  await put("/curated/feed", change);
  // Every cached feed and leaderboard answer was for the old settings. Stats and insights don't
  // depend on them, so they stay cached (the Models tab keeps painting at once).
  invalidate("/curated/models");
  invalidate("/matches");
}

/** The next checked list after ticking or unticking `id`, in leaderboard order. */
export function toggledModels(board: Leaderboard, id: string): string[] {
  const checked = new Set(board.selectedModels);
  if (checked.has(id)) checked.delete(id);
  else checked.add(id);
  return board.entries.filter((e) => checked.has(e.id)).map((e) => e.id);
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

  useEffect(() => setPending(null), [board]);

  const save = async (models: string[] | null) => {
    setSaving(true);
    setError(null);
    setPending(models ?? []);
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

  const following = board.followBest === true && pending === null;
  const summary = following
    ? `Best: ${names[0] ?? "–"}`
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
              Following the best performer. Ticking a model switches to your own picks.
            </p>
          )}
          {board.entries.map((e) => {
            const on = checked.has(e.id);
            const last = on && checked.size === 1;
            return (
              <label key={e.id} className={`checklist-row${on ? " on" : ""}`} title={e.description}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={saving || last}
                  onChange={() => void save(toggledModels({ ...board, selectedModels: [...checked] }, e.id))}
                />
                <span className="checklist-name">
                  <span className="faint num">#{e.rank}</span> {e.name}
                  {e.isDefault && <span className="chip chip-model">best</span>}
                </span>
                <span className="num muted">
                  {e.composite.score === null ? "–" : e.composite.score.toFixed(0)}
                </span>
              </label>
            );
          })}
          {board.followBest === false && (
            <button className="ghost small-btn" disabled={saving} onClick={() => void save(null)}>
              Follow the best performer
            </button>
          )}
        </div>
      </details>
      {error && <small className="error">{error}</small>}
    </div>
  );
}
