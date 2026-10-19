import { useEffect, useMemo, useRef, useState } from "react";
import { SCOPE_COLUMNS, scopeColumnsFor, type ScopeColumn } from "../scope";
import {
  activeFilterCount,
  resetColumnFilter,
  resetScopeDisplay,
  setColumnFilter,
  setScopeDisplay,
  useScopeSettings,
  type ScopeColumnFilter,
  type ScopeDisplay,
  type ScopeSize,
} from "../scopeSettings";
import { SCOPE_CHIP_DEFS } from "../scopeChips";
import { scopeSampleCard } from "../scopeSample";
import { useNow } from "../hooks";
import type { TileMode } from "../tileTone";
import { CloseIcon } from "./Icons";
import { QuickLinkChecks, ThemeAndColors } from "./AppearancePanel";
import { ScopeRow, scopeLookClass } from "./ScopeBoard";

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
  tiles,
}: {
  open: boolean;
  section: ScopeSettingsSection;
  onClose: () => void;
  /** Models seen on the board, for the Models column's pick list. */
  modelNames: string[];
  /** Your filters seen on the board, for the Your filters column's pick list. */
  filterNames: string[];
  /** How the board colors its chips, for the example row. */
  tiles: TileMode;
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
          {(
            [
              "display",
              ...scopeColumnsFor(settings.display.stream).map((c) => c.id),
            ] as ScopeSettingsSection[]
          ).map((id) => {
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
            <DisplaySettings display={settings.display} tiles={tiles} />
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

function DisplaySettings({ display: d, tiles }: { display: ScopeDisplay; tiles: TileMode }) {
  const now = useNow(5_000);
  const sample = useMemo(() => scopeSampleCard(Date.now()), []);
  const flip = (key: BoolKey) => setScopeDisplay({ [key]: !d[key] });
  const sw = (key: BoolKey, label: string, hint?: string) => (
    <Switch label={label} hint={hint} on={d[key]} onChange={() => flip(key)} />
  );
  return (
    <div className="scope-settings-body">
      {/* First, as the switch that changes the board most (user ask 2026-10-19). */}
      <section className="scope-section">
        {sw(
          "stream",
          "Stream",
          "New and About to graduate, from every token that passes the safety screen, in place of Your filters and Models",
        )}
      </section>
      <div className="scope-preview">
        <span className="scope-preview-label">Preview</span>
        <div className={`scope scope-preview-board ${scopeLookClass(d)}`}>
          <div className="scope-rows">
            <ScopeRow card={sample} now={now} display={d} tiles={tiles} preview />
          </div>
        </div>
      </div>
      <section className="scope-section">
        <h3>Look</h3>
        <Seg
          label="Spacing"
          value={d.density}
          options={[
            ["compact", "Compact"],
            ["cozy", "Cozy"],
            ["roomy", "Roomy"],
          ]}
          onChange={(density) => setScopeDisplay({ density })}
        />
        <Seg
          label="Rows as"
          value={d.layout}
          options={[
            ["cards", "Cards"],
            ["list", "List"],
          ]}
          onChange={(layout) => setScopeDisplay({ layout })}
        />
        <Seg
          label="Image"
          value={d.imageSize}
          options={SIZES}
          onChange={(imageSize) => setScopeDisplay({ imageSize })}
        />
        <Seg
          label="Text"
          value={d.textSize}
          options={SIZES}
          onChange={(textSize) => setScopeDisplay({ textSize })}
        />
        <Seg
          label="Chips"
          value={d.chipStyle}
          options={[
            ["soft", "Soft"],
            ["outline", "Outline"],
            ["plain", "Plain"],
          ]}
          onChange={(chipStyle) => setScopeDisplay({ chipStyle })}
        />
        <p className="muted small">Phones keep rows a little tighter so more fit.</p>
      </section>
      <section className="scope-section">
        <h3>On each row</h3>
        {sw("showName", "Token name")}
        {sw(
          "tickerCopiesCa",
          "Click the ticker to copy the CA",
          "Off: the ticker opens the coin, like the rest of the row",
        )}
        {sw("showAge", "Age")}
        {sw("showFees", "Creator fee", "Where the fee goes, as on the cards")}
        {sw("showSocials", "X and website links")}
        {sw("showTradeLinks", "Trade links", "Your sites below, plus Dex and Pump")}
        {sw("showSource", "Where it came from", "Your filter's icon, the model's name, HC")}
        {sw("showAt", "Market cap at the alert")}
        {sw("showPeak", "Peak since the alert")}
        {sw("showResult", "Result mark", "2x hit or missed, on the image")}
        {sw("colorMcap", "Color the market cap", "Green when up since the alert, red when down")}
        {sw("highlightNew", "Highlight new alerts", "The age shows green for the first minute")}
      </section>
      <section className="scope-section">
        <h3>Data chips</h3>
        <p className="muted small">Readings under each row, colored like the alert card&apos;s tiles.</p>
        {CHIP_GROUPS.map((g) => (
          <div key={g} className="scope-pick-group">
            <span className="scope-pick-label">{g}</span>
            <div className="scope-pills">
              {SCOPE_CHIP_DEFS.filter((c) => c.group === g).map((c) => {
                const on = d.chips.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={`scope-pill${on ? " on" : ""}`}
                    aria-pressed={on}
                    onClick={() =>
                      setScopeDisplay({ chips: on ? d.chips.filter((x) => x !== c.id) : [...d.chips, c.id] })
                    }
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </section>
      <section className="scope-section">
        <h3>Board</h3>
        {sw(
          "pauseOnHover",
          "Hold still while I'm reading",
          "New rows wait behind a pill while your pointer or finger is on the board",
        )}
        <div className="scope-pick-group">
          <span className="scope-pick-label">Columns</span>
          <div className="scope-pills">
            {scopeColumnsFor(d.stream).map((c, _, board) => {
              const shown = !d.hiddenColumns.includes(c.id);
              const last = shown && board.filter((b) => !d.hiddenColumns.includes(b.id)).length <= 1;
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`scope-pill${shown ? " on" : ""}`}
                  aria-pressed={shown}
                  disabled={last}
                  title={last ? "One column always shows" : undefined}
                  onClick={() =>
                    setScopeDisplay({
                      hiddenColumns: shown
                        ? [...d.hiddenColumns, c.id]
                        : d.hiddenColumns.filter((x) => x !== c.id),
                    })
                  }
                >
                  {c.label}
                </button>
              );
            })}
          </div>
        </div>
      </section>
      {/* What Scope shows from the shared look, so it's all set from here too (user ask 2026-10-19). */}
      <section className="scope-section appearance-controls">
        <h3>Theme and colors</h3>
        <p className="muted small">The same as in Cards&apos; Customize, and saved to your account.</p>
        <ThemeAndColors cards={false} />
      </section>
      <section className="scope-section appearance-controls">
        <h3>Trade links</h3>
        <p className="muted small">Sites shown with Trade links, as on the cards.</p>
        <QuickLinkChecks />
      </section>
      <div className="scope-settings-foot">
        <button type="button" className="ghost small-btn" onClick={resetScopeDisplay}>
          Back to defaults
        </button>
      </div>
    </div>
  );
}

type BoolKey = {
  [K in keyof ScopeDisplay]: ScopeDisplay[K] extends boolean ? K : never;
}[keyof ScopeDisplay];

const SIZES: [ScopeSize, string][] = [
  ["s", "Small"],
  ["m", "Medium"],
  ["l", "Large"],
];

const CHIP_GROUPS = [...new Set(SCOPE_CHIP_DEFS.map((c) => c.group))];

/** A labelled row of segmented choices. */
function Seg<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div className="scope-seg-row">
      <span className="scope-seg-label">{label}</span>
      <div className="segmented small" role="radiogroup" aria-label={label}>
        {options.map(([v, text]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={value === v}
            className={value === v ? "on" : ""}
            onClick={() => onChange(v)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

/** An on/off switch with its label and an optional line under it. */
function Switch({
  label,
  hint,
  on,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  on: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <label className={`scope-switch${disabled ? " disabled" : ""}`}>
      <span className="scope-switch-text">
        {label}
        {hint && <span className="muted small">{hint}</span>}
      </span>
      <input type="checkbox" role="switch" checked={on} disabled={disabled} onChange={onChange} />
      <span className="scope-switch-track" aria-hidden="true" />
    </label>
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
      <p className="muted small scope-settings-intro">
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
        {(col === "filters" || col === "models") && (
          <Switch
            label="Show graduated alerts here too"
            hint="Alerts whose coin graduated move to the Graduated column, marked with their source"
            on={f.showGraduated}
            onChange={() => set({ showGraduated: !f.showGraduated })}
          />
        )}
        {(col === "filters" || col === "models") && (
          <Switch
            label="Hide alerts that missed"
            hint="Missed 2x or stopped out"
            on={f.hideMissed}
            onChange={() => set({ hideMissed: !f.hideMissed })}
          />
        )}
      </fieldset>
      {col === "models" && (
        <fieldset className="scope-fieldset">
          <legend>Models</legend>
          <Switch
            label="High-conviction calls only"
            on={f.highOnly}
            onChange={() => set({ highOnly: !f.highOnly })}
          />
          {models.length === 0 ? (
            <p className="muted small">No model calls on the board yet to pick from.</p>
          ) : (
            <>
              <span className="scope-pick-label">Only these models (none picked: all of them)</span>
              <div className="scope-pills">
                {models.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`scope-pill${f.models.includes(m) ? " on" : ""}`}
                    aria-pressed={f.models.includes(m)}
                    onClick={() => set({ models: pick(f.models, m) })}
                  >
                    {m}
                  </button>
                ))}
              </div>
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
              <span className="scope-pick-label">Only these filters (none picked: all of them)</span>
              <div className="scope-pills">
                {filters.map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`scope-pill${f.filters.includes(n) ? " on" : ""}`}
                    aria-pressed={f.filters.includes(n)}
                    onClick={() => set({ filters: pick(f.filters, n) })}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </>
          )}
        </fieldset>
      )}
      {activeFilterCount(f) > 0 && (
        <div className="scope-settings-foot">
          <button type="button" className="ghost small-btn" onClick={() => resetColumnFilter(col)}>
            Clear {label} filters
          </button>
        </div>
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
