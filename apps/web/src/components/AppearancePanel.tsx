import { useEffect, useMemo, useRef, useState } from "react";
import type { Card, CardField } from "../api";
import {
  CARD_FIELD_GROUPS,
  DEFAULT_APPEARANCE,
  PRESETS,
  SWATCHES,
  feedGridProps,
  sameAppearance,
  setAppearance,
  useAppearance,
  useAppearanceSave,
  withPreset,
  cardHideSet,
} from "../appearance";
import { AlertCard } from "./AlertCard";
import { PaletteIcon } from "./Icons";
import { useNow } from "../hooks";

/**
 * Settings › Feed appearance: theme, colors, spacing, columns and which card fields show, with a
 * live preview card. Every change shows at once and is saved to the wallet's account, so the look
 * follows the user to their other devices.
 */
export function AppearancePanel() {
  const look = useAppearance();
  const save = useAppearanceSave();
  const now = useNow(60_000);
  const [sample, setSample] = useState<"won" | "missed">("won");
  const hidden = useMemo(() => cardHideSet(look), [look]);
  const cards = useMemo(() => sampleCards(now), [now]);
  const isDefault = sameAppearance(look, DEFAULT_APPEARANCE);

  return (
    <section className="panel appearance" id="feed-appearance">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <PaletteIcon size={13} /> Feed appearance
          </span>
          <h2>How your feed looks</h2>
          <p className="muted small">
            Changes show at once and are saved to your wallet&apos;s account, so your feed looks the same on
            every device you sign in on.
          </p>
        </div>
        <div className="appearance-actions">
          <SaveNote save={save} />
          <button className="ghost" disabled={isDefault} onClick={() => setAppearance(DEFAULT_APPEARANCE)}>
            Reset to default
          </button>
        </div>
      </header>

      <div className="appearance-layout">
        <div className="appearance-preview">
          <div className="preview-head">
            <span className="small muted">Preview</span>
            <div className="segmented small" role="tablist" aria-label="Preview card">
              <button
                role="tab"
                aria-selected={sample === "won"}
                className={sample === "won" ? "on" : ""}
                onClick={() => setSample("won")}
              >
                Model call, won
              </button>
              <button
                role="tab"
                aria-selected={sample === "missed"}
                className={sample === "missed" ? "on" : ""}
                onClick={() => setSample("missed")}
              >
                Your filter, missed
              </button>
            </div>
          </div>
          <div className="cards preview-cards" {...feedGridProps({ ...look, columns: 1, phoneColumns: 1 })}>
            <AlertCard card={cards[sample]} now={now} labelSource hide={hidden} />
          </div>
        </div>

        <AppearanceControls />
      </div>
    </section>
  );
}

/**
 * Every appearance control (presets, theme and colors, layout, card fields). Shared by the Settings
 * section and the Live tab's Customize panel, where the feed itself is the preview.
 */
export function AppearanceControls() {
  const look = useAppearance();
  const hidden = useMemo(() => new Set(look.hidden), [look.hidden]);
  const activePreset = PRESETS.find((p) => sameAppearance(withPreset(look, p.look), look))?.id ?? null;
  const toggleField = (f: CardField) =>
    setAppearance({ hidden: hidden.has(f) ? look.hidden.filter((x) => x !== f) : [...look.hidden, f] });

  return (
    <div className="appearance-controls">
      <fieldset>
        <legend>Presets</legend>
        <div className="preset-options">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`sound-option${activePreset === p.id ? " on" : ""}`}
              aria-pressed={activePreset === p.id}
              onClick={() => setAppearance(withPreset(look, p.look))}
            >
              <strong>{p.label}</strong>
              <small className="muted">{p.hint}</small>
            </button>
          ))}
        </div>
        <p className="faint small">Presets keep your theme and colors.</p>
      </fieldset>

      <fieldset>
        <legend>Theme and colors</legend>
        <Choice
          label="Theme"
          value={look.theme}
          options={[
            ["auto", "Match device"],
            ["dark", "Dark"],
            ["light", "Light"],
          ]}
          onChange={(theme) => setAppearance({ theme })}
        />
        <ColorRow
          label="Wins"
          hint="Won cards, Peak and up moves"
          value={look.win}
          onChange={(win) => setAppearance({ win })}
        />
        <ColorRow
          label="Losses"
          hint="Missed cards, down moves and risky wallet tiles"
          value={look.loss}
          onChange={(loss) => setAppearance({ loss })}
        />
        <ColorRow
          label="Model calls"
          hint="Model pills, reasons and the model card edge"
          value={look.accent}
          onChange={(accent) => setAppearance({ accent })}
        />
        <ColorRow
          label="Your filter"
          hint="Your filter's pill and card edge"
          value={look.mine}
          onChange={(mine) => setAppearance({ mine })}
        />
      </fieldset>

      <fieldset>
        <legend>Layout and spacing</legend>
        <Choice
          label="Spacing"
          value={look.density}
          options={[
            ["compact", "Compact"],
            ["cozy", "Standard"],
            ["roomy", "Roomy"],
          ]}
          onChange={(density) => setAppearance({ density })}
        />
        <Choice
          label="Columns on a computer"
          value={String(look.columns)}
          options={[
            ["0", "Auto"],
            ["1", "1"],
            ["2", "2"],
            ["3", "3"],
            ["4", "4"],
          ]}
          onChange={(c) => setAppearance({ columns: Number(c) })}
        />
        {look.columns === 0 && (
          <Choice
            label="Card width"
            value={look.cardWidth}
            options={[
              ["narrow", "Narrow"],
              ["normal", "Standard"],
              ["wide", "Wide"],
            ]}
            onChange={(cardWidth) => setAppearance({ cardWidth })}
          />
        )}
        <Choice
          label="Columns on a phone"
          value={String(look.phoneColumns)}
          options={[
            ["1", "1"],
            ["2", "2"],
          ]}
          onChange={(c) => setAppearance({ phoneColumns: Number(c) })}
        />
        <TextSize value={look.textSize} onCommit={(textSize) => setAppearance({ textSize })} />
        <Choice
          label="Corners"
          value={look.corners}
          options={[
            ["square", "Square"],
            ["rounded", "Rounded"],
            ["round", "Round"],
          ]}
          onChange={(corners) => setAppearance({ corners })}
        />
        <Choice
          label="Token image"
          value={look.avatar}
          options={[
            ["small", "Small"],
            ["normal", "Standard"],
            ["large", "Large"],
          ]}
          onChange={(avatar) => setAppearance({ avatar })}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={look.sourceStripe}
            onChange={() => setAppearance({ sourceStripe: !look.sourceStripe })}
          />
          Colored edge for your filter vs model calls
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={look.learningNote}
            onChange={() => setAppearance({ learningNote: !look.learningNote })}
          />
          &ldquo;Learning from…&rdquo; note under the feed
        </label>
      </fieldset>

      <fieldset>
        <legend>What cards show</legend>
        <div className="field-groups">
          {CARD_FIELD_GROUPS.map((g) => (
            <div key={g.title} className="field-group">
              <h4>{g.title}</h4>
              {g.fields.map((f) => (
                <label key={f.id} className="check">
                  <input type="checkbox" checked={!hidden.has(f.id)} onChange={() => toggleField(f.id)} />
                  {f.label}
                </label>
              ))}
            </div>
          ))}
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={look.volume}
            // Switching volume on also unhides it, in case an older preset hid the old tile.
            onChange={() =>
              setAppearance({ volume: !look.volume, hidden: look.hidden.filter((x) => x !== "vol") })
            }
          />
          Volume tiles: 5m, 1h and 24h
        </label>
        {look.hidden.length > 0 && (
          <button type="button" className="ghost small-btn" onClick={() => setAppearance({ hidden: [] })}>
            Show everything
          </button>
        )}
      </fieldset>
    </div>
  );
}

export function SaveNote({ save }: { save: ReturnType<typeof useAppearanceSave> }) {
  if (save.state === "idle") return null;
  return (
    <small
      className={`save-note ${save.state === "error" ? "error" : "faint"}`}
      role="status"
      title={save.state === "error" ? save.message : undefined}
    >
      {save.state === "saving"
        ? "Saving…"
        : save.state === "saved"
          ? "Saved to your account"
          : "Couldn't save to your account; kept on this device"}
    </small>
  );
}

/** A labelled row of choices (a segmented control). */
function Choice<T extends string>({
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
    <div className="choice-row">
      <span className="small muted">{label}</span>
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

/** One color: swatches, a free picker, and back to the theme's own. */
function ColorRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  // The native picker fires on every drag step; show those here and save once it is let go.
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const commit = useRef(onChange);
  commit.current = onChange;
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const done = () => {
      setDraft(null);
      commit.current(el.value);
    };
    el.addEventListener("change", done);
    return () => el.removeEventListener("change", done);
  }, []);
  const shown = draft ?? value;
  return (
    <div className="color-row">
      <div className="color-label">
        <span className="small">{label}</span>
        <small className="faint">{hint}</small>
      </div>
      <div className="swatches" role="radiogroup" aria-label={`${label} color`}>
        <button
          type="button"
          role="radio"
          aria-checked={shown === null}
          className={`swatch swatch-default${shown === null ? " on" : ""}`}
          title="Theme default"
          aria-label="Theme default"
          onClick={() => onChange(null)}
        >
          A
        </button>
        {SWATCHES.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={shown === c}
            className={`swatch${shown === c ? " on" : ""}`}
            style={{ background: c }}
            title={c}
            aria-label={c}
            onClick={() => onChange(c)}
          />
        ))}
        <label
          className={`swatch swatch-custom${shown !== null && !SWATCHES.includes(shown) ? " on" : ""}`}
          title="Pick any color"
          style={shown !== null && !SWATCHES.includes(shown) ? { background: shown } : undefined}
        >
          <input
            ref={inputRef}
            type="color"
            value={shown ?? "#8b5cf6"}
            aria-label={`${label}: pick any color`}
            onChange={(e) => setDraft(e.target.value)}
          />
          +
        </label>
      </div>
    </div>
  );
}

/** Text size: the slider moves freely and saves when let go. */
function TextSize({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const ref = useRef<HTMLInputElement>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const done = () => commit.current(Number(el.value));
    el.addEventListener("change", done);
    return () => el.removeEventListener("change", done);
  }, []);
  return (
    <label className="volume text-size">
      <span className="small muted">Text size</span>
      <input
        ref={ref}
        type="range"
        min={85}
        max={125}
        step={5}
        value={draft}
        aria-label="Card text size"
        onChange={(e) => setDraft(Number(e.target.value))}
      />
      <span className="num small volume-value">{draft}%</span>
      <small className="faint text-size-note">Phones go up to 105% so numbers aren&apos;t cut short.</small>
    </label>
  );
}

/** Two made-up cards for the preview: a model call that ran to 4x, and a filter alert that missed. */
function sampleCards(now: number): { won: Card; missed: Card } {
  const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
  const snapshot = (mcap: number, extra: Partial<Card["snapshot"]> = {}): Card["snapshot"] => ({
    takenAt: at(42),
    priceUsd: mcap / 1e9,
    marketCapUsd: mcap,
    liquidityUsd: 9_800,
    volume24hUsd: 61_400,
    volume5mUsd: 18_200,
    volume1hUsd: 47_900,
    volumeToMcapRatio: 2.4,
    buys24h: 412,
    sells24h: 233,
    holderCount: 186,
    holderGrowthPct: 12,
    top10HolderPct: 24.6,
    devWalletPct: 2.1,
    riskScore: 1,
    freshTop10WalletPct: 30,
    emptyTop10WalletPct: 20,
    firstBuyersHolding: 9,
    firstBuyersSeen: 25,
    devHolding: false,
    ageMinutes: 14,
    graduated: false,
    score: 82,
    ...extra,
  });
  const won: Card = {
    id: "preview-won",
    kind: "curated",
    tokenId: "preview-1",
    matchedAt: at(42),
    score: 71,
    peakReturnPct: 312,
    token: {
      id: "preview-1",
      mintAddress: "PreviewMint111111111111111111111111111pump",
      symbol: "SAMPLE",
      name: "Sample Coin",
      imageUrl: null,
    },
    snapshot: snapshot(24_500),
    latestSnapshot: null,
    currentMarketCapUsd: 78_900,
    filter: null,
    curated: {
      alertId: "preview-won",
      source: "model",
      model: "preview",
      modelName: "Gradient Boost",
      confidence: 82,
      tier: "high",
      calibratedPct: 41,
      reasons: ["Strong buy pressure", "Holders growing fast", "Low top 10 share"],
      alertedAt: at(42),
      outcome: {
        status: "won",
        hit2x: true,
        hitGoal: true,
        hitTenX: false,
        peak1hReturnPct: 312,
        maxDrawdown1hPct: -12,
        peak24hReturnPct: 312,
        runPeakMinutes: 21,
        finalized: true,
        minutesLeft: null,
      },
    },
  };
  const missed: Card = {
    id: "preview-missed",
    kind: "match",
    tokenId: "preview-2",
    matchedAt: at(35),
    score: 58,
    peakReturnPct: 38,
    token: {
      id: "preview-2",
      mintAddress: "PreviewMint222222222222222222222222222pump",
      symbol: "DEMO",
      name: "Demo Token",
      imageUrl: null,
    },
    snapshot: snapshot(18_200, { freshTop10WalletPct: 80, holderCount: 97, devHolding: true, score: 64 }),
    latestSnapshot: null,
    currentMarketCapUsd: 11_300,
    filter: { id: "preview", name: "My filter" },
    curated: null,
    hit2xIn1h: false,
    hit4xIn1h: false,
    hit10xIn1h: false,
    disqualified: false,
  };
  return { won, missed };
}
