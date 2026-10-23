import type { Filter, Leaderboard } from "../api";
import { usePolling } from "../hooks";
import { kindDef, MAX_SCOPE_COLUMNS, MAX_SCOPE_PICKS, SCOPE_KINDS, type ScopeColumn } from "../scope";
import {
  activeFilterCount,
  addScopeColumn,
  moveScopeColumn,
  removeScopeColumn,
  resetScopeBoard,
  setColumnKind,
  setColumnPicks,
  type ScopeBoardColumn,
} from "../scopeSettings";
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, FunnelIcon, PlusIcon } from "./Icons";

/**
 * Scope's columns (user ask 2026-10-23): up to six, left to right, each one of New, About to
 * graduate, Graduated, your filters (all, or up to three), or model calls (the models you follow,
 * or up to three of any). In place of the old Stream switch, which swapped two fixed columns.
 */
export function ScopeColumnsPanel({
  board,
  onFilters,
}: {
  board: ScopeBoardColumn[];
  /** Opens a column's own filters. */
  onFilters: (col: ScopeColumn) => void;
}) {
  const filters = usePolling<Filter[]>("/filters", 120_000);
  const lb = usePolling<Leaderboard>("/curated/models?days=30", 120_000);
  const full = board.length >= MAX_SCOPE_COLUMNS;
  const filterOptions = (filters.data ?? []).map((f) => ({
    id: f.id,
    name: f.name,
    note: f.isActive ? "" : "Off",
  }));
  const followed = new Set(lb.data?.selectedModels ?? []);
  const modelOptions = (lb.data?.entries ?? []).map((e) => ({
    id: e.id,
    name: e.name,
    note: followed.has(e.id) ? "Following" : "",
  }));
  return (
    <div className="scope-settings-body">
      <p className="muted small scope-settings-intro">
        Up to {MAX_SCOPE_COLUMNS} columns, left to right. Wide screens show them side by side (scroll sideways
        when they don&apos;t fit), phones as tabs. Alerts whose coin graduated move to a Graduated column when
        the board has one.
      </p>
      <ol className="scope-colset">
        {board.map((col, i) => {
          const def = kindDef(col.kind);
          const count = activeFilterCount(col.filter);
          const options = def.picks === "filter" ? filterOptions : def.picks === "model" ? modelOptions : [];
          // Picks no longer offered (a deleted filter, a retired model) stay listed so they can come off.
          const known = new Set(options.map((o) => o.id));
          const stale = col.picks
            .filter((id) => !known.has(id))
            .map((id) => ({ id, name: "Not found", note: "" }));
          return (
            <li key={col.id} className="scope-colset-item">
              <div className="scope-colset-head">
                <span className="scope-colset-num num" aria-hidden="true">
                  {i + 1}
                </span>
                <label className="scope-colset-kind">
                  <span className="sr-only">Column {i + 1} shows</span>
                  <select
                    value={col.kind}
                    onChange={(e) => setColumnKind(col.id, e.target.value as typeof col.kind)}
                  >
                    {SCOPE_KINDS.map((k) => (
                      <option key={k.kind} value={k.kind}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="scope-colset-tools">
                  <button
                    type="button"
                    className={`ghost icon-btn scope-filter-btn${count > 0 ? " on" : ""}`}
                    onClick={() => onFilters(col.id)}
                    title={`This column's filters${count > 0 ? ` (${count} on)` : ""}`}
                    aria-label={`Column ${i + 1} filters${count > 0 ? `, ${count} on` : ""}`}
                  >
                    <FunnelIcon size={14} />
                    {count > 0 && <span className="scope-filter-count num">{count}</span>}
                  </button>
                  <button
                    type="button"
                    className="ghost icon-btn"
                    disabled={i === 0}
                    onClick={() => moveScopeColumn(col.id, -1)}
                    title="Move left"
                    aria-label={`Move column ${i + 1} left`}
                  >
                    <ChevronLeftIcon size={14} />
                  </button>
                  <button
                    type="button"
                    className="ghost icon-btn"
                    disabled={i === board.length - 1}
                    onClick={() => moveScopeColumn(col.id, 1)}
                    title="Move right"
                    aria-label={`Move column ${i + 1} right`}
                  >
                    <ChevronRightIcon size={14} />
                  </button>
                  <button
                    type="button"
                    className="ghost icon-btn scope-colset-remove"
                    disabled={board.length <= 1}
                    onClick={() => removeScopeColumn(col.id)}
                    title={board.length <= 1 ? "One column always shows" : "Remove this column"}
                    aria-label={`Remove column ${i + 1}`}
                  >
                    <CloseIcon size={14} />
                  </button>
                </span>
              </div>
              <p className="muted small scope-colset-hint">{def.hint}</p>
              {def.picks && (
                <div className="scope-colset-picks">
                  <span className="scope-pick-label">
                    {def.picks === "filter" ? "Filters" : "Models"}{" "}
                    <span className="num">
                      {col.picks.length}/{MAX_SCOPE_PICKS}
                    </span>
                  </span>
                  {options.length + stale.length === 0 ? (
                    <p className="muted small">
                      {(def.picks === "filter" ? filters : lb).data === null
                        ? "Loading…"
                        : def.picks === "filter"
                          ? "You have no saved filters yet."
                          : "No models to pick from yet."}
                    </p>
                  ) : (
                    <div className="scope-pills">
                      {[...options, ...stale].map((o) => {
                        const on = col.picks.includes(o.id);
                        const blocked = !on && col.picks.length >= MAX_SCOPE_PICKS;
                        return (
                          <button
                            key={o.id}
                            type="button"
                            className={`scope-pill${on ? " on" : ""}`}
                            aria-pressed={on}
                            disabled={blocked}
                            title={blocked ? `Up to ${MAX_SCOPE_PICKS} per column` : o.name}
                            onClick={() =>
                              setColumnPicks(
                                col.id,
                                on ? col.picks.filter((p) => p !== o.id) : [...col.picks, o.id],
                              )
                            }
                          >
                            {o.name}
                            {o.note && <span className="scope-pill-note">{o.note}</span>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <section className="scope-section">
        <h3>
          Add a column{" "}
          <span className="muted small num">
            {board.length}/{MAX_SCOPE_COLUMNS}
          </span>
        </h3>
        <div className="scope-colset-add">
          {SCOPE_KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              className="ghost small-btn"
              disabled={full}
              title={full ? `Up to ${MAX_SCOPE_COLUMNS} columns` : k.hint}
              onClick={() => addScopeColumn(k.kind)}
            >
              <PlusIcon size={13} /> {k.label}
            </button>
          ))}
        </div>
      </section>
      <div className="scope-settings-foot">
        <button type="button" className="ghost small-btn" onClick={resetScopeBoard}>
          Back to the default columns
        </button>
      </div>
    </div>
  );
}
