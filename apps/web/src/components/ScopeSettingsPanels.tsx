import { useEffect, useMemo, useState } from "react";
import { isModelSide, kindDef, type ScopeColumnKind } from "../scope";
import {
  activeFilterCount,
  resetColumnFilter,
  resetScopeDisplay,
  setColumnFilter,
  setScopeDisplay,
  type ScopeBoardColumn,
  type ScopeColumnFilter,
  type ScopeDisplay,
  type ScopeSize,
} from "../scopeSettings";
import { SCOPE_CHIP_DEFS } from "../scopeChips";
import { scopeSampleCard } from "../scopeSample";
import { useNow } from "../hooks";
import type { TileMode } from "../tileTone";
import { ScopeRow, scopeLookClass } from "./ScopeBoard";

/**
 * Scope's settings (user ask 2026-10-18), shown in Customize's Scope sections: how the rows look
 * (with an example row that stays in view), which columns the board has (user ask 2026-10-23,
 * ScopeColumnsPanel), and each column's filters. A column's filter icon opens Customize on them.
 */
export function DisplaySettings({ display: d, tiles }: { display: ScopeDisplay; tiles: TileMode }) {
  const now = useNow(5_000);
  const sample = useMemo(() => scopeSampleCard(Date.now()), []);
  const flip = (key: BoolKey) => setScopeDisplay({ [key]: !d[key] });
  const sw = (key: BoolKey, label: string, hint?: string) => (
    <Switch label={label} hint={hint} on={d[key]} onChange={() => flip(key)} />
  );
  return (
    <div className="scope-settings-body">
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
        {sw("showSearch", "Search button", "Search the ticker, name or contract")}
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
          "New rows wait behind a pill while your mouse is on the board or you've scrolled down a list",
        )}
      </section>
      <p className="muted small">
        Theme, colors and the trade-link sites are shared with Cards, under Look and Trading.
      </p>
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
export function Seg<T extends string>({
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
export function Switch({
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

export function ColumnFilters({ col: column, label }: { col: ScopeBoardColumn; label: string }) {
  const col: ScopeColumnKind = column.kind;
  const f: ScopeColumnFilter = column.filter;
  const set = (change: Partial<ScopeColumnFilter>) => setColumnFilter(column.id, change);
  const alerts = col === "filters" || col === "filter" || isModelSide(col);
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
        {alerts && (
          <Switch
            label="Show graduated alerts here too"
            hint="With a Graduated column on the board, alerts whose coin graduated move there, marked with their source"
            on={f.showGraduated}
            onChange={() => set({ showGraduated: !f.showGraduated })}
          />
        )}
        {alerts && (
          <Switch
            label="Hide alerts that missed"
            hint="Missed 2x or stopped out"
            on={f.hideMissed}
            onChange={() => set({ hideMissed: !f.hideMissed })}
          />
        )}
      </fieldset>
      {isModelSide(col) && (
        <fieldset className="scope-fieldset">
          <legend>Calls</legend>
          <Switch
            label="High-conviction calls only"
            on={f.highOnly}
            onChange={() => set({ highOnly: !f.highOnly })}
          />
        </fieldset>
      )}
      {kindDef(col).picks && (
        <p className="muted small">
          Which {col === "filter" ? "filters" : "models"} it shows is set under Columns.
        </p>
      )}
      {activeFilterCount(f) > 0 && (
        <div className="scope-settings-foot">
          <button type="button" className="ghost small-btn" onClick={() => resetColumnFilter(column.id)}>
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
