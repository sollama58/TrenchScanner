import { useEffect, useRef, useState } from "react";
import { SCOPE_COLUMNS, type ScopeColumn } from "../scope";
import {
  activeFilterCount,
  resetColumnFilter,
  resetScopeDisplay,
  SCOPE_CHIPS,
  setColumnFilter,
  setScopeDisplay,
  useScopeSettings,
  type ScopeColumnFilter,
  type ScopeDisplay,
} from "../scopeSettings";
import { CloseIcon } from "./Icons";

export type ScopeSettingsSection = "display" | ScopeColumn;

/**
 * Scope's own settings window (user ask 2026-10-18), apart from the Cards view's Customize: how
 * the rows look, and each column's filters. A column's filter icon opens it on that column.
 */
export function ScopeSettingsModal({
  open,
  section,
  onClose,
  modelNames,
  filterNames,
}: {
  open: boolean;
  section: ScopeSettingsSection;
  onClose: () => void;
  /** Models seen on the board, for the Models column's pick list. */
  modelNames: string[];
  /** Your filters seen on the board, for the Your filters column's pick list. */
  filterNames: string[];
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<ScopeSettingsSection>(section);
  useEffect(() => {
    if (open) setTab(section);
  }, [open, section]);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  const settings = useScopeSettings();

  return (
    <dialog
      ref={ref}
      className="about-modal sheet-modal scope-settings"
      aria-labelledby="scope-settings-title"
      onClose={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="about-body">
        <header className="about-head">
          <h2 id="scope-settings-title">Scope settings</h2>
          <button className="ghost icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </header>
        <div className="segmented small scope-settings-tabs" role="tablist" aria-label="Scope settings">
          {(["display", ...SCOPE_COLUMNS.map((c) => c.id)] as ScopeSettingsSection[]).map((id) => {
            const col = SCOPE_COLUMNS.find((c) => c.id === id);
            const count = col ? activeFilterCount(settings.columns[col.id]) : 0;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? "on" : ""}
                onClick={() => setTab(id)}
              >
                {col ? col.short : "Display"}
                {count > 0 && <span className="scope-filter-count num">{count}</span>}
              </button>
            );
          })}
        </div>
        {open &&
          (tab === "display" ? (
            <DisplaySettings display={settings.display} />
          ) : (
            <ColumnFilters
              col={tab}
              f={settings.columns[tab]}
              modelNames={modelNames}
              filterNames={filterNames}
            />
          ))}
      </div>
    </dialog>
  );
}

function DisplaySettings({ display: d }: { display: ScopeDisplay }) {
  const toggle = (key: keyof ScopeDisplay, label: string, hint?: string) => (
    <label className="scope-check" title={hint}>
      <input
        type="checkbox"
        checked={d[key] as boolean}
        onChange={() => setScopeDisplay({ [key]: !d[key] })}
      />
      {label}
    </label>
  );
  return (
    <div className="scope-settings-body">
      <fieldset className="scope-fieldset">
        <legend>Rows</legend>
        {toggle("compact", "Compact rows", "Tighter rows with a smaller image, so more fit on screen")}
        {toggle("showName", "Token name")}
        {toggle("showSource", "Where it came from (filter, model, HC)")}
        {toggle("showSocials", "X and website links")}
        {toggle("showAt", "Market cap at the alert")}
        {toggle("showPeak", "Peak since the alert")}
        {toggle("showResult", "Result mark (2x hit, missed)")}
      </fieldset>
      <fieldset className="scope-fieldset">
        <legend>Chips under each row</legend>
        {SCOPE_CHIPS.map((c) => (
          <label key={c.id} className="scope-check">
            <input
              type="checkbox"
              checked={d.chips.includes(c.id)}
              onChange={() =>
                setScopeDisplay({
                  chips: d.chips.includes(c.id) ? d.chips.filter((x) => x !== c.id) : [...d.chips, c.id],
                })
              }
            />
            {c.label}
          </label>
        ))}
      </fieldset>
      <fieldset className="scope-fieldset">
        <legend>Board</legend>
        {toggle(
          "pauseOnHover",
          "Hold still while I'm reading",
          "New rows wait behind a pill while your pointer or finger is on the board",
        )}
        {SCOPE_COLUMNS.map((c) => {
          const shown = !d.hiddenColumns.includes(c.id);
          const last = shown && d.hiddenColumns.length >= SCOPE_COLUMNS.length - 1;
          return (
            <label key={c.id} className="scope-check">
              <input
                type="checkbox"
                checked={shown}
                disabled={last}
                onChange={() =>
                  setScopeDisplay({
                    hiddenColumns: shown
                      ? [...d.hiddenColumns, c.id]
                      : d.hiddenColumns.filter((x) => x !== c.id),
                  })
                }
              />
              Show the {c.label} column
            </label>
          );
        })}
      </fieldset>
      <button type="button" className="ghost small-btn" onClick={resetScopeDisplay}>
        Back to defaults
      </button>
    </div>
  );
}

function ColumnFilters({
  col,
  f,
  modelNames,
  filterNames,
}: {
  col: ScopeColumn;
  f: ScopeColumnFilter;
  modelNames: string[];
  filterNames: string[];
}) {
  const set = (change: Partial<ScopeColumnFilter>) => setColumnFilter(col, change);
  const label = SCOPE_COLUMNS.find((c) => c.id === col)!.label;
  // Names already picked stay listed even when none of their alerts are on the board right now.
  const models = [...new Set([...modelNames, ...f.models])].sort();
  const filters = [...new Set([...filterNames, ...f.filters])].sort();
  const pick = (list: string[], name: string) =>
    list.includes(name) ? list.filter((n) => n !== name) : [...list, name];
  return (
    <div className="scope-settings-body">
      <p className="muted small">
        Only what passes these shows in {label}. A coin with no reading for a filter isn&apos;t hidden by it.
        These apply to Scope only, on top of your feed.
      </p>
      <fieldset className="scope-fieldset scope-grid">
        <legend>Market</legend>
        <NumField
          label="Market cap from"
          unit="$K"
          value={f.mcapMin}
          scale={1000}
          onChange={(v) => set({ mcapMin: v })}
        />
        <NumField
          label="Market cap up to"
          unit="$K"
          value={f.mcapMax}
          scale={1000}
          onChange={(v) => set({ mcapMax: v })}
        />
        <NumField label="Newer than" unit="min" value={f.maxAgeMin} onChange={(v) => set({ maxAgeMin: v })} />
        <NumField
          label="Peak at least"
          unit="%"
          value={f.minPeakPct}
          onChange={(v) => set({ minPeakPct: v })}
        />
      </fieldset>
      <fieldset className="scope-fieldset scope-grid">
        <legend>Holders</legend>
        <NumField label="Holders at least" value={f.minHolders} onChange={(v) => set({ minHolders: v })} />
        <NumField
          label="Top 10 at most"
          unit="%"
          value={f.maxTop10Pct}
          onChange={(v) => set({ maxTop10Pct: v })}
        />
        <NumField
          label="Fresh at most"
          unit="%"
          value={f.maxFreshPct}
          onChange={(v) => set({ maxFreshPct: v })}
        />
        <NumField
          label="Snipers at most"
          unit="/25"
          value={f.maxSnipers}
          onChange={(v) => set({ maxSnipers: v })}
        />
        <NumField
          label="Linked at most"
          unit="%"
          value={f.maxLinkedPct}
          onChange={(v) => set({ maxLinkedPct: v })}
        />
      </fieldset>
      <fieldset className="scope-fieldset">
        <legend>Links and results</legend>
        <div className="choice-row">
          <span className="small muted">Must have</span>
          <div className="segmented small" role="radiogroup" aria-label="Must have">
            {(
              [
                ["any", "Any"],
                ["either", "X or site"],
                ["x", "X"],
                ["website", "Site"],
                ["both", "Both"],
              ] as const
            ).map(([v, text]) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={f.socials === v}
                className={f.socials === v ? "on" : ""}
                onClick={() => set({ socials: v })}
              >
                {text}
              </button>
            ))}
          </div>
        </div>
        {col !== "graduated" && (
          <label className="scope-check">
            <input
              type="checkbox"
              checked={f.hideMissed}
              onChange={() => set({ hideMissed: !f.hideMissed })}
            />
            Hide alerts that missed 2x or stopped out
          </label>
        )}
      </fieldset>
      {col === "models" && (
        <fieldset className="scope-fieldset">
          <legend>Models</legend>
          <label className="scope-check">
            <input type="checkbox" checked={f.highOnly} onChange={() => set({ highOnly: !f.highOnly })} />
            High-conviction calls only
          </label>
          {models.length === 0 ? (
            <p className="muted small">No model calls on the board yet to pick from.</p>
          ) : (
            <>
              <span className="small muted">Only these models (none picked: all of them)</span>
              {models.map((m) => (
                <label key={m} className="scope-check">
                  <input
                    type="checkbox"
                    checked={f.models.includes(m)}
                    onChange={() => set({ models: pick(f.models, m) })}
                  />
                  {m}
                </label>
              ))}
            </>
          )}
        </fieldset>
      )}
      {col === "filters" && (
        <fieldset className="scope-fieldset">
          <legend>Your filters</legend>
          {filters.length === 0 ? (
            <p className="muted small">No filter alerts on the board yet to pick from.</p>
          ) : (
            <>
              <span className="small muted">Only these filters (none picked: all of them)</span>
              {filters.map((n) => (
                <label key={n} className="scope-check">
                  <input
                    type="checkbox"
                    checked={f.filters.includes(n)}
                    onChange={() => set({ filters: pick(f.filters, n) })}
                  />
                  {n}
                </label>
              ))}
            </>
          )}
        </fieldset>
      )}
      {activeFilterCount(f) > 0 && (
        <button type="button" className="ghost small-btn" onClick={() => resetColumnFilter(col)}>
          Clear {label} filters
        </button>
      )}
    </div>
  );
}

/** A number box that is empty when off; `scale` shows thousands as K. */
function NumField({
  label,
  unit,
  value,
  scale = 1,
  onChange,
}: {
  label: string;
  unit?: string;
  value: number | null;
  scale?: number;
  onChange: (v: number | null) => void;
}) {
  const [text, setText] = useState(value === null ? "" : String(value / scale));
  useEffect(() => {
    setText(value === null ? "" : String(value / scale));
  }, [value, scale]);
  const commit = (raw: string) => {
    const t = raw.trim().replace(",", ".");
    if (t === "") return onChange(null);
    const n = Number(t);
    if (Number.isFinite(n) && n >= 0) onChange(n * scale);
  };
  return (
    <label className="scope-num">
      <span className="small muted">{label}</span>
      <span className="scope-num-box">
        <input
          type="text"
          inputMode="decimal"
          placeholder="Off"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit((e.target as HTMLInputElement).value);
          }}
        />
        {unit && <span className="small muted">{unit}</span>}
      </span>
    </label>
  );
}
