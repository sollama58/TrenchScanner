import { useEffect, useRef, useState } from "react";
import { del, patch, post, ApiError, type AppConfig, type Filter, type FilterInput } from "../api";
import { usePolling } from "../hooks";
import { pct, usd } from "../format";
import { EditIcon, PlusIcon, SlidersIcon, TrashIcon } from "../components/Icons";

/** Mirrors MAX_FILTERS_PER_USER in apps/api/src/routes/filters.ts. */
const MAX_FILTERS = 10;

type NumberField = {
  [K in keyof FilterInput]: FilterInput[K] extends number | null ? K : never;
}[keyof FilterInput];

interface FieldSpec {
  key: NumberField;
  label: string;
  hint: string;
  unit?: string;
  step?: number;
}

const GROUPS: { title: string; blurb: string; fields: FieldSpec[] }[] = [
  {
    title: "Momentum",
    blurb: "Is money and attention arriving?",
    fields: [
      {
        key: "minVolumeMcapRatio",
        label: "Min 24h volume ÷ market cap",
        hint: "e.g. 0.5 = volume at least half the market cap",
        step: 0.1,
      },
      { key: "minHolderGrowthPct", label: "Min holder growth", hint: "over the last 30 minutes", unit: "%" },
      { key: "minScore", label: "Min composite score", hint: "0-100, the scanner's overall score" },
    ],
  },
  {
    title: "Safety",
    blurb: "Screens out the setups that usually end in a rug.",
    fields: [
      { key: "maxTop10HolderPct", label: "Max top-10 holders", hint: "share of supply", unit: "%" },
      { key: "maxDevWalletPct", label: "Max dev wallet", hint: "share of supply", unit: "%" },
      { key: "maxRiskScore", label: "Max RugCheck risk", hint: "0-100, lower is safer" },
      {
        key: "maxFreshTop10WalletPct",
        label: "Max fresh wallets",
        hint: "top-10 holders on wallets under a day old",
        unit: "%",
      },
      {
        key: "maxEmptyTop10WalletPct",
        label: "Max empty holder wallets",
        hint: "top-10 holders with nothing else",
        unit: "%",
      },
      {
        key: "minFirstBuyersHolding",
        label: "Min first buyers holding",
        hint: "of the first 25 buyers; tokens without a count are skipped",
        unit: "of 25",
        step: 1,
      },
      {
        key: "maxFirstBuyersHolding",
        label: "Max first buyers holding",
        hint: "of the first 25 buyers, e.g. 10 = snipers mostly gone",
        unit: "of 25",
        step: 1,
      },
    ],
  },
  {
    title: "Age",
    blurb: "How long the token has existed.",
    fields: [
      {
        key: "minTokenAgeMinutes",
        label: "Min age",
        hint: "minutes; 0.5 = 30 seconds",
        unit: "min",
        step: 0.25,
      },
      { key: "maxTokenAgeMinutes", label: "Max age", hint: "minutes", unit: "min" },
    ],
  },
];

function blankFilter(config: AppConfig | null, count: number): FilterInput {
  return {
    name: `Filter ${count + 1}`,
    mcapMin: config?.mcapFilterMin ?? 10_000,
    mcapMax: config?.mcapFilterMax ?? 1_000_000,
    minVolumeMcapRatio: null,
    minHolderGrowthPct: null,
    maxTop10HolderPct: null,
    maxDevWalletPct: null,
    maxRiskScore: null,
    excludeCriticalRiskFlags: true,
    minTokenAgeMinutes: null,
    maxTokenAgeMinutes: null,
    narrativeKeywords: [],
    minScore: null,
    maxFreshTop10WalletPct: null,
    maxEmptyTop10WalletPct: null,
    minFirstBuyersHolding: null,
    maxFirstBuyersHolding: null,
    isActive: count === 0,
  };
}

function toInput(f: Filter): FilterInput {
  const { id: _id, createdAt: _c, trackRecord: _t, ...rest } = f;
  return {
    ...rest,
    narrativeKeywords: rest.narrativeKeywords ?? [],
  };
}

/** The Filters tab: up to ten saved setups, one active at a time. */
export function FiltersTab() {
  const filters = usePolling<Filter[]>("/filters", 120_000);
  const config = usePolling<AppConfig>("/config", 600_000);
  // `opened` tells apart two editors for the same filter (or two new ones), so opening again starts
  // the form over instead of keeping the last one's keyword text.
  const [editing, setEditing] = useState<{ id: string | null; draft: FilterInput; opened: number } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const list = filters.data ?? [];
  const full = list.length >= MAX_FILTERS;

  const run = async (action: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      if (done) setMessage(done);
      filters.reload();
      return true;
    } catch (e) {
      setMessage(e instanceof ApiError || e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!editing) return;
    const ok = await run(
      () => (editing.id ? patch(`/filters/${editing.id}`, editing.draft) : post("/filters", editing.draft)),
      editing.id ? "Filter saved." : "Filter created.",
    );
    if (ok) setEditing(null);
  };

  return (
    <div className="columns filters-layout">
      <section className="panel">
        <header className="section-head">
          <div>
            <span className="eyebrow">Filters</span>
            <h2>Your saved filters</h2>
            <p className="muted">
              {list.length} of {MAX_FILTERS} saved. Only the active one alerts; switch whenever you like.
            </p>
          </div>
          <button
            className="primary"
            disabled={full || busy}
            title={full ? "Delete a filter to add another" : undefined}
            onClick={() =>
              setEditing({ id: null, draft: blankFilter(config.data, list.length), opened: Date.now() })
            }
          >
            <PlusIcon size={15} /> New filter
          </button>
        </header>
        {message && <p className="notice">{message}</p>}
        {filters.error && !filters.data && (
          <p className="error">Couldn't load filters: {filters.error.message}</p>
        )}
        {list.length === 0 && filters.data && (
          <div className="empty-state">
            <SlidersIcon size={28} />
            <p>No filters yet. Create one to get your own alerts.</p>
          </div>
        )}
        <ul className="filter-list">
          {list.map((f) => {
            const rec = f.trackRecord;
            return (
              <li
                key={f.id}
                className={`filter-item ${f.isActive ? "active" : ""} ${editing?.id === f.id ? "editing" : ""}`}
              >
                <label className="radio">
                  <input
                    type="radio"
                    name="active-filter"
                    checked={f.isActive}
                    disabled={busy}
                    onChange={() =>
                      run(() => post(`/filters/${f.id}/activate`), `“${f.name}” is now active.`)
                    }
                  />
                  <span>
                    <strong>{f.name}</strong>
                    {f.isActive && <span className="pill pill-model">Active</span>}
                    <small className="muted block">
                      {usd(f.mcapMin)}–{usd(f.mcapMax)}
                      {f.narrativeKeywords.length > 0 && ` · ${f.narrativeKeywords.slice(0, 3).join(", ")}`}
                    </small>
                  </span>
                </label>
                <div className="filter-record">
                  {rec && rec.graded > 0 ? (
                    <span title="Last 30 days, graded alerts">
                      <strong className="num">{pct((rec.won2x / rec.graded) * 100)}</strong> 2x ·{" "}
                      <strong className="num">{pct((rec.won4x / rec.graded) * 100)}</strong> 4x
                      <small className="muted block">{rec.graded} graded, 30d</small>
                    </span>
                  ) : (
                    <small className="muted">no graded alerts yet</small>
                  )}
                </div>
                <div className="row gap-xs">
                  <button
                    className="icon-btn"
                    title="Edit"
                    aria-label={`Edit ${f.name}`}
                    onClick={() => setEditing({ id: f.id, draft: toInput(f), opened: Date.now() })}
                    disabled={busy}
                  >
                    <EditIcon size={15} />
                  </button>
                  <button
                    className="icon-btn danger"
                    title="Delete"
                    aria-label={`Delete ${f.name}`}
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`Delete “${f.name}”?`))
                        void run(() => del(`/filters/${f.id}`), "Filter deleted.");
                    }}
                  >
                    <TrashIcon size={15} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="panel editor">
        {editing ? (
          <FilterEditor
            key={`${editing.id ?? "new"}:${editing.opened}`}
            draft={editing.draft}
            isNew={editing.id === null}
            config={config.data}
            busy={busy}
            onChange={(draft) => setEditing({ ...editing, draft })}
            onCancel={() => setEditing(null)}
            onSave={save}
          />
        ) : (
          <div className="editor-empty">
            <span className="feature-icon big">
              <SlidersIcon size={22} />
            </span>
            <h3>Build a filter</h3>
            <p className="muted">
              A filter is your own screen over everything the scanner sees. Pick one to edit, or start a new
              one. Leave a field blank to ignore it.
            </p>
            <p className="muted small">
              Each filter's 2x / 4x rate uses the same rule as the curated feed: 2x within 15 minutes (4x
              within 30) of a realistic fill, before a 50% drop.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function FilterEditor({
  draft,
  isNew,
  config,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  draft: FilterInput;
  isNew: boolean;
  config: AppConfig | null;
  busy: boolean;
  onChange: (d: FilterInput) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const [keywords, setKeywords] = useState(draft.narrativeKeywords.join(", "));
  const set = <K extends keyof FilterInput>(key: K, value: FilterInput[K]) =>
    onChange({ ...draft, [key]: value });
  const num = (v: string): number | null => (v.trim() === "" ? null : Number(v));
  // On a phone the editor sits below the list, out of sight: bring it up when it opens.
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const el = formRef.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    if (top > window.innerHeight * 0.6 || top < 0) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <form
      ref={formRef}
      className="editor-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <h3>{isNew ? "New filter" : `Edit “${draft.name}”`}</h3>

      <label className="field">
        <span>Name</span>
        <input value={draft.name} maxLength={60} required onChange={(e) => set("name", e.target.value)} />
      </label>

      <fieldset>
        <legend>Market cap</legend>
        <p className="muted small">
          The scanner covers {usd(config?.scanBandMin)}–{usd(config?.scanBandMax)}.
        </p>
        <div className="grid2">
          <label className="field">
            <span>From ($)</span>
            <input
              type="number"
              inputMode="decimal"
              min={config?.scanBandMin}
              step="any"
              required
              value={draft.mcapMin}
              onChange={(e) => set("mcapMin", Number(e.target.value))}
            />
          </label>
          <label className="field">
            <span>To ($)</span>
            <input
              type="number"
              inputMode="decimal"
              max={config?.scanBandMax}
              step="any"
              required
              value={draft.mcapMax}
              onChange={(e) => set("mcapMax", Number(e.target.value))}
            />
          </label>
        </div>
      </fieldset>

      {GROUPS.map((g) => (
        <fieldset key={g.title}>
          <legend>{g.title}</legend>
          <p className="muted small">{g.blurb}</p>
          <div className="grid2">
            {g.fields.map((f) => (
              <label className="field" key={f.key}>
                <span>
                  {f.label}
                  {f.unit ? ` (${f.unit})` : ""}
                </span>
                <input
                  type="number"
                  inputMode="decimal"
                  step={f.step ?? "any"}
                  placeholder="any"
                  value={draft[f.key] ?? ""}
                  onChange={(e) => set(f.key, num(e.target.value))}
                />
                <small className="faint">{f.hint}</small>
              </label>
            ))}
          </div>
          {g.title === "Safety" && (
            <label className="check">
              <input
                type="checkbox"
                checked={draft.excludeCriticalRiskFlags}
                onChange={(e) => set("excludeCriticalRiskFlags", e.target.checked)}
              />
              Skip tokens with a critical RugCheck flag
            </label>
          )}
        </fieldset>
      ))}

      <fieldset>
        <legend>Narrative</legend>
        <label className="field">
          <span>Keywords (comma-separated, any match)</span>
          <input
            value={keywords}
            placeholder="e.g. ai, cat, trump"
            onChange={(e) => {
              setKeywords(e.target.value);
              set(
                "narrativeKeywords",
                e.target.value
                  .split(",")
                  .map((k) => k.trim())
                  .filter(Boolean)
                  .slice(0, 20),
              );
            }}
          />
        </label>
      </fieldset>

      <label className="check">
        <input type="checkbox" checked={draft.isActive} onChange={(e) => set("isActive", e.target.checked)} />
        Make this my active filter (switches the others off)
      </label>

      <div className="row gap-s end">
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={busy}>
          {isNew ? "Create filter" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
