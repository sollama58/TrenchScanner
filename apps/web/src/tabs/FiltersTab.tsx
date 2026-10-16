import { useEffect, useRef, useState } from "react";
import {
  del,
  patch,
  post,
  ApiError,
  type AppConfig,
  type Filter,
  type FilterInput,
  type Leaderboard,
} from "../api";
import { usePolling } from "../hooks";
import { pct, usd } from "../format";
import { GROUPS, LAUNCHPAD_CHOICES, shownValue } from "../filterFields";
import { useSettings } from "../alerts";
import { ScoreExplainer } from "../components/ScoreExplainer";
import { BellIcon, EditIcon, PlusIcon, SlidersIcon, TrashIcon } from "../components/Icons";
import { TopFiltersPick } from "../components/TopFilters";
import { AlertsPanel, ModelPanel } from "../components/AlertDeliveryPanels";
import { TelegramPanel } from "../components/TelegramPanel";
import { FilterGlyph } from "../components/FilterBadge";
import { FILTER_COLORS, FILTER_ICONS, filterCardStyle } from "../filterStyle";

/** Mirrors MAX_FILTERS_PER_USER in apps/api/src/routes/filters.ts. */
const MAX_FILTERS = 10;

// The starting values every new filter opens with. Below the platform's MCAP_FILTER_MIN on purpose:
// the API accepts anything inside the padded scan band (scanBand), which reaches down to $5k.
const DEFAULT_FILTER_MCAP_MIN = 8_000;

function blankFilter(config: AppConfig | null, count: number): FilterInput {
  return {
    name: `Filter ${count + 1}`,
    mcapMin: Math.max(DEFAULT_FILTER_MCAP_MIN, config?.scanBandMin ?? 0),
    mcapMax: config?.mcapFilterMax ?? 1_000_000,
    minVolumeMcapRatio: null,
    minHolderGrowthPct: null,
    maxTop10HolderPct: null,
    maxLargestHolderPct: null,
    maxDevWalletPct: null,
    maxRiskScore: null,
    excludeCriticalRiskFlags: true,
    minTokenAgeMinutes: 0.5,
    maxTokenAgeMinutes: null,
    narrativeKeywords: [],
    minScore: null,
    maxFreshTop10WalletPct: 40,
    maxEmptyTop10WalletPct: 60,
    maxSniperTop10WalletPct: null,
    maxSniperTopHolderCount: null,
    maxLinkedWalletPct: null,
    maxLinkedWalletCount: null,
    maxFlaggedBuySol: null,
    minCexFundedCount: null,
    maxCexFundedCount: null,
    maxSameTimeFundedPct: null,
    maxSameTimeFundedCount: null,
    maxLinkedCreatorPct: null,
    maxKolBundledPct: null,
    maxBundledSupplyPct: null,
    minLiveHolderCount: null,
    minFirstBuyersHolding: null,
    maxFirstBuyersHolding: null,
    launchpads: [],
    narrativeCategories: [],
    excludeNarrativeCategories: [],
    excludeCopycats: false,
    excludeNarrativeRedFlags: false,
    excludeUnrelatedX: false,
    requireTrendMatch: false,
    excludeLateCopies: false,
    color: null,
    icon: null,
    isActive: true,
    shareOnLeaderboard: false,
  };
}

function toInput(f: Filter): FilterInput {
  const { id: _id, createdAt: _c, criteriaChangedAt: _cc, trackRecord: _t, ...rest } = f;
  return {
    ...rest,
    narrativeKeywords: rest.narrativeKeywords ?? [],
    // Absent from filters saved by older API builds.
    launchpads: rest.launchpads ?? [],
    narrativeCategories: rest.narrativeCategories ?? [],
    excludeNarrativeCategories: rest.excludeNarrativeCategories ?? [],
    excludeCopycats: rest.excludeCopycats ?? false,
    excludeNarrativeRedFlags: rest.excludeNarrativeRedFlags ?? false,
    excludeUnrelatedX: rest.excludeUnrelatedX ?? false,
    requireTrendMatch: rest.requireTrendMatch ?? false,
    excludeLateCopies: rest.excludeLateCopies ?? false,
    color: rest.color ?? null,
    icon: rest.icon ?? null,
  };
}

/**
 * The Filters tab: up to ten saved setups, each switched on or off on its own; then how the alerts they raise
 * reach you (Telegram, your preferred model, sound and browser notifications); then the
 * shared-filter leaderboard (Top filters).
 */
export function FiltersTab({ goTo }: { goTo: (tab: "live" | "model") => void }) {
  const filters = usePolling<Filter[]>("/filters", 120_000);
  const config = usePolling<AppConfig>("/config", 600_000);
  const settings = useSettings();
  const [pick, setPick] = useState(0);
  const board = usePolling<Leaderboard>("/curated/models?days=30", 120_000, String(pick));
  // `opened` tells apart two editors for the same filter (or two new ones), so opening again starts
  // the form over instead of keeping the last one's keyword text.
  const [editing, setEditing] = useState<{ id: string | null; draft: FilterInput; opened: number } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // A failed save, shown in the editor too: on a phone the list's notice is off-screen above it.
  const [saveError, setSaveError] = useState<{ opened: number; text: string | null } | null>(null);
  const lastError = useRef<string | null>(null);

  const list = filters.data ?? [];
  const full = list.length >= MAX_FILTERS;

  const run = async (action: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setMessage(null);
    lastError.current = null;
    try {
      await action();
      if (done) setMessage(done);
      filters.reload();
      return true;
    } catch (e) {
      lastError.current = e instanceof ApiError || e instanceof Error ? e.message : String(e);
      setMessage(lastError.current);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!editing) return;
    setSaveError(null);
    const ok = await run(
      () => (editing.id ? patch(`/filters/${editing.id}`, editing.draft) : post("/filters", editing.draft)),
      editing.id ? "Filter saved." : "Filter created.",
    );
    if (ok) setEditing(null);
    else setSaveError({ opened: editing.opened, text: lastError.current });
  };

  return (
    <div className="stack">
      <div className="columns filters-layout">
        <section className="panel">
          <header className="section-head">
            <div>
              <span className="eyebrow">Filters</span>
              <h2>Your saved filters</h2>
              <p className="muted">
                {list.length} of {MAX_FILTERS} saved, {list.filter((f) => f.isActive).length} on. Every filter
                that&apos;s on alerts; switch one off to pause it without losing its settings.
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
                  style={filterCardStyle(f.color) as React.CSSProperties}
                >
                  <div className="filter-main">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={f.isActive}
                      aria-label={`Alerts from ${f.name}`}
                      title={
                        f.isActive
                          ? "On: alerting. Switch off to pause it."
                          : "Off: paused. Switch on to alert."
                      }
                      className={`switch${f.isActive ? " on" : ""}`}
                      disabled={busy}
                      onClick={() => {
                        const on = !f.isActive;
                        void run(
                          () => patch(`/filters/${f.id}`, { isActive: on }),
                          on ? `“${f.name}” is on.` : `“${f.name}” is off. Its settings are kept.`,
                        ).then((ok) => {
                          // An open editor saves its whole draft, isActive included: keep it in step
                          // so saving doesn't undo the switch just made here.
                          if (ok)
                            setEditing((e) =>
                              e?.id === f.id ? { ...e, draft: { ...e.draft, isActive: on } } : e,
                            );
                        });
                      }}
                    >
                      <span className="switch-track">
                        <span className="switch-thumb" />
                      </span>
                    </button>
                    <span>
                      {(f.color || f.icon) && (
                        <span
                          className={`pill pill-icon filter-mark ${f.color ? "pill-filter" : "pill-mine"}`}
                          role="img"
                          aria-label="Card style"
                          title="Its alerts' cards carry this color and icon"
                        >
                          <FilterGlyph icon={f.icon} />
                        </span>
                      )}
                      <strong>{f.name}</strong>
                      {!f.isActive && <span className="pill">Off</span>}
                      {f.shareOnLeaderboard && <span className="pill">Shared</span>}
                      <small className="muted block">
                        {usd(f.mcapMin)}–{usd(f.mcapMax)}
                        {f.narrativeKeywords.length > 0 && ` · ${f.narrativeKeywords.slice(0, 3).join(", ")}`}
                      </small>
                    </span>
                  </div>
                  <div className="filter-record">
                    {rec && rec.graded > 0 ? (
                      <span title="Last 30 days, graded alerts">
                        <strong className="num">{pct((rec.won2x / rec.graded) * 100)}</strong> 2x ·{" "}
                        <strong className="num">{pct((rec.won4x / rec.graded) * 100)}</strong> 4x
                        {rec.won10x !== undefined && (rec.tenXGraded ?? rec.graded) > 0 && (
                          <>
                            {" "}
                            ·{" "}
                            <strong className="num">
                              {pct((rec.won10x / (rec.tenXGraded ?? rec.graded)) * 100)}
                            </strong>{" "}
                            10x
                          </>
                        )}
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
                        if (!window.confirm(`Delete “${f.name}”?`)) return;
                        void run(() => del(`/filters/${f.id}`), "Filter deleted.").then((ok) => {
                          // The editor can't save a filter that no longer exists.
                          if (ok) setEditing((e) => (e?.id === f.id ? null : e));
                        });
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
              saveError={saveError?.opened === editing.opened ? saveError.text : null}
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
                Each filter's 2x / 4x / 10x rate uses the same rule as the curated feed: 2x within 15 minutes
                (4x within 30, 10x within an hour) of the alert price, before a 50% drop.
              </p>
              <TopFiltersPick onCopied={filters.reload} />
            </div>
          )}
        </section>
      </div>
      <section className="alerts-band" aria-labelledby="alerts-band-title">
        <header className="section-head band-head">
          <div>
            <span className="eyebrow">
              <BellIcon size={13} /> Alerts
            </span>
            <h2 id="alerts-band-title">How your alerts reach you</h2>
            <p className="muted">
              The filters you have on and your preferred model decide what alerts you; this is where they go.
              Everything here is saved to your wallet.
            </p>
          </div>
        </header>
        <div className="delivery-grid">
          <TelegramPanel board={board.data} />
          <ModelPanel
            board={board.data}
            stale={board.stale}
            onChanged={() => setPick((n) => n + 1)}
            goTo={goTo}
          />
          <AlertsPanel prefs={settings?.alerts ?? null} />
        </div>
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
  saveError,
}: {
  draft: FilterInput;
  isNew: boolean;
  config: AppConfig | null;
  busy: boolean;
  onChange: (d: FilterInput) => void;
  onCancel: () => void;
  onSave: () => void;
  saveError: string | null;
}) {
  const [keywords, setKeywords] = useState(draft.narrativeKeywords.join(", "));
  const themes = config?.narrativeCategories ?? [];
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

      <fieldset style={filterCardStyle(draft.color) as React.CSSProperties}>
        <legend>Card style</legend>
        <p className="muted small">
          A color and icon for the feed cards this filter raises. They replace your Customize outline and
          accent on those cards; leave both on Default to keep the Customize look.
        </p>
        <div className="field">
          <span>Color</span>
          <div className="filter-style-pick" role="group" aria-label="Card color">
            <button
              type="button"
              className="none"
              aria-pressed={draft.color === null}
              onClick={() => set("color", null)}
            >
              Default
            </button>
            {FILTER_COLORS.map((c) => (
              <button
                type="button"
                key={c.hex}
                className="swatch"
                style={{ "--swatch": c.hex } as React.CSSProperties}
                title={c.label}
                aria-label={c.label}
                aria-pressed={draft.color === c.hex}
                onClick={() => set("color", c.hex)}
              />
            ))}
          </div>
        </div>
        <div className="field">
          <span>Icon</span>
          <div className="filter-style-pick" role="group" aria-label="Card icon">
            <button
              type="button"
              className="none"
              aria-pressed={draft.icon === null}
              onClick={() => set("icon", null)}
            >
              Default
            </button>
            {FILTER_ICONS.map((i) => (
              <button
                type="button"
                key={i.id}
                className="icon-choice"
                title={i.label}
                aria-label={i.label}
                aria-pressed={draft.icon === i.id}
                onClick={() => set("icon", i.id)}
              >
                <FilterGlyph icon={i.id} size={15} />
              </button>
            ))}
          </div>
        </div>
      </fieldset>

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

      <fieldset>
        <legend>Launchpad</legend>
        <p className="muted small">Leave both unticked for coins from either.</p>
        {LAUNCHPAD_CHOICES.map((l) => (
          <label className="check" key={l.id}>
            <input
              type="checkbox"
              checked={draft.launchpads.includes(l.id)}
              onChange={(e) =>
                set(
                  "launchpads",
                  e.target.checked ? [...draft.launchpads, l.id] : draft.launchpads.filter((x) => x !== l.id),
                )
              }
            />
            {l.label} only
          </label>
        ))}
      </fieldset>

      {GROUPS.map((g) => (
        <fieldset key={g.title}>
          <legend>{g.title}</legend>
          <p className="muted small">{g.blurb}</p>
          <div className="grid2">
            {g.fields
              .filter((f) => !f.retired || draft[f.key] != null)
              .map((f) => (
                // htmlFor: a field with an info button inside its label still focuses its input.
                <label className="field" key={f.key} htmlFor={`filter-${f.key}`}>
                  <span>
                    {f.label}
                    {f.unit ? ` (${f.unit})` : ""}
                    {f.explainScore && <ScoreExplainer />}
                  </span>
                  <input
                    id={`filter-${f.key}`}
                    type="number"
                    inputMode="decimal"
                    step={f.step ?? "any"}
                    min={f.min}
                    max={f.max}
                    placeholder="any"
                    value={shownValue(f, draft[f.key]) ?? ""}
                    onChange={(e) => {
                      const v = num(e.target.value);
                      set(f.key, v === null || !f.scale ? v : v * f.scale);
                    }}
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
        <p className="muted small">
          The settings below use TokenSage&apos;s read of what each coin is about. They only match coins that
          have been read: a coin without a read yet is skipped, and the X-post and trend settings wait for the
          deep read.
        </p>
        {themes.length > 0 && (
          <div className="grid2">
            <ThemePicker
              title="Only these themes"
              themes={themes}
              chosen={draft.narrativeCategories}
              onChange={(v) => set("narrativeCategories", v)}
            />
            <ThemePicker
              title="Never these themes"
              themes={themes}
              chosen={draft.excludeNarrativeCategories}
              onChange={(v) => set("excludeNarrativeCategories", v)}
            />
          </div>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={draft.excludeCopycats}
            onChange={(e) => set("excludeCopycats", e.target.checked)}
          />
          Skip copycats and reused names
        </label>
        {/* Merged away (user decision 2026-10-15, notes/overlap-audit-2026-10-15/report.md): shown only
            on a filter that still has them on, so they can be cleared. 98% of late copies are
            copycats, and Spoofed X, the only red flag TokenSage raised, no longer counts. */}
        {draft.excludeLateCopies && (
          <label className="check">
            <input
              type="checkbox"
              checked={draft.excludeLateCopies}
              onChange={(e) => set("excludeLateCopies", e.target.checked)}
            />
            Skip late copies (old: replaced by Skip copycats above, which takes in almost every late copy;
            still applies until you untick it)
          </label>
        )}
        {draft.excludeNarrativeRedFlags && (
          <label className="check">
            <input
              type="checkbox"
              checked={draft.excludeNarrativeRedFlags}
              onChange={(e) => set("excludeNarrativeRedFlags", e.target.checked)}
            />
            Skip coins with a narrative red flag (old: its only flag was a spoofed X post, which no longer
            counts; untick to clear it)
          </label>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={draft.excludeUnrelatedX}
            onChange={(e) => set("excludeUnrelatedX", e.target.checked)}
          />
          Skip coins whose linked X post is unrelated (needs the deep read)
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.requireTrendMatch}
            onChange={(e) => set("requireTrendMatch", e.target.checked)}
          />
          Only coins whose name is trending on Wikipedia or in the news (needs the deep read)
        </label>
      </fieldset>

      <label className="check">
        <input type="checkbox" checked={draft.isActive} onChange={(e) => set("isActive", e.target.checked)} />
        On: alert me on what this filter catches (your other filters stay as they are)
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={draft.shareOnLeaderboard}
          onChange={(e) => set("shareOnLeaderboard", e.target.checked)}
        />
        Share on the filter leaderboard (shows the name and settings, never your wallet)
      </label>
      {!isNew && draft.shareOnLeaderboard && (
        <p className="muted small">Changing any setting starts this filter's leaderboard record over.</p>
      )}

      {saveError && <p className="error small">Couldn&apos;t save: {saveError}</p>}
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

/** A list of theme checkboxes; a theme ticked here is a top-level TokenSage category id. */
function ThemePicker({
  title,
  themes,
  chosen,
  onChange,
}: {
  title: string;
  themes: { id: string; label: string }[];
  chosen: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (id: string, on: boolean) =>
    onChange(on ? [...chosen.filter((c) => c !== id), id] : chosen.filter((c) => c !== id));
  return (
    <div className="field">
      <span>{title}</span>
      <div className="check-list">
        {themes.map((t) => (
          <label className="check small" key={t.id}>
            <input
              type="checkbox"
              checked={chosen.includes(t.id)}
              onChange={(e) => toggle(t.id, e.target.checked)}
            />
            {t.label}
          </label>
        ))}
      </div>
    </div>
  );
}
