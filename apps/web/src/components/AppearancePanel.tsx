import { useEffect, useMemo, useRef, useState } from "react";
import type { CardField, NarrativeNoteReadiness, QuickLink } from "../api";
import {
  CARD_FIELD_GROUPS,
  HIDE_BELOW_MCAP,
  PRESETS,
  QUICK_LINK_SITES,
  SWATCHES,
  sameAppearance,
  setAppearance,
  useAppearance,
  useAppearanceSave,
  withPreset,
} from "../appearance";
import { useNarrativeNoteReadiness } from "../narrativeNote";

/** The bubble maps' names that can be shown or hidden kind by kind (user ask 2026-10-16). */
const NAME_KINDS = [
  ["bubbleNamesPumpfun", "Pump.fun names"],
  ["bubbleNamesHelius", "Helius names"],
  ["bubbleNamesFomo", "FOMO names"],
] as const;

/**
 * Every appearance control (presets, theme and colors, layout, card fields), in the Live and Stream
 * tabs' Customize panel, where the feed itself is the preview. Every change shows at once and is
 * saved to the wallet's account, so the look follows the user to their other devices.
 */
export function AppearanceControls() {
  const look = useAppearance();
  const narrative = useNarrativeNoteReadiness();
  const narrativeShown = look.narrativeNote ?? narrative?.ready ?? false;
  const namesSplit = NAME_KINDS.some(([key]) => look[key] !== null);
  const hidden = useMemo(() => new Set(look.hidden), [look.hidden]);
  const activePreset = PRESETS.find((p) => sameAppearance(withPreset(look, p.look), look))?.id ?? null;
  const shown = (f: CardField) =>
    !hidden.has(f) &&
    (f !== "reasons" || look.reasons) &&
    (f !== "sniperTop10" || look.sniperTop10) &&
    (f !== "dev" || look.devTile) &&
    (f !== "largest" || look.largest) &&
    (f !== "kolBundled" || look.kolBundled) &&
    (f !== "transferred" || look.transferred);
  const toggleField = (f: CardField) =>
    f === "reasons" ||
    f === "sniperTop10" ||
    f === "largest" ||
    f === "kolBundled" ||
    f === "transferred" ||
    f === "dev"
      ? // Opt-in: switching it on also unhides it, in case an older preset hid it.
        setAppearance({
          [f === "dev" ? "devTile" : f]: !shown(f),
          hidden: look.hidden.filter((x) => x !== f),
        })
      : setAppearance({ hidden: hidden.has(f) ? look.hidden.filter((x) => x !== f) : [...look.hidden, f] });
  const toggleQuickLink = (id: QuickLink) =>
    setAppearance({
      // Kept in the listed order, so the card's links don't shuffle as they're switched.
      quickLinks: QUICK_LINK_SITES.map((l) => l.id).filter((x) =>
        x === id ? !look.quickLinks.includes(id) : look.quickLinks.includes(x),
      ),
    });

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
          hint="Model pills and reasons"
          value={look.accent}
          onChange={(accent) => setAppearance({ accent })}
        />
        <ColorRow
          label="Your filter"
          hint="Your filter's pill"
          value={look.mine}
          onChange={(mine) => setAppearance({ mine })}
        />
        <ColorRow
          label="Card outline"
          hint="Around each card while its alert is still grading (A is a neutral grey)"
          value={look.outline}
          onChange={(outline) => setAppearance({ outline })}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={look.outlineResult}
            onChange={() => setAppearance({ outlineResult: !look.outlineResult })}
          />
          Mark graded cards: a thin green or red line along the top when an alert passes or fails
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={look.tileColors}
            onChange={() => setAppearance({ tileColors: !look.tileColors })}
          />
          Color the stat tiles&apos; readings: from the lower color, through the median, to the upper color at
          the safety screen&apos;s cutoff
        </label>
        {look.tileColors && (
          <>
            <label className="check">
              <input
                type="checkbox"
                checked={look.tileFill}
                onChange={() => setAppearance({ tileFill: !look.tileFill })}
              />
              Color the whole tile, not only the reading
            </label>
            <ColorRow
              label="Tiles: lower"
              hint="Well inside the cutoff (A is your Wins color)"
              value={look.tileLow}
              onChange={(tileLow) => setAppearance({ tileLow })}
            />
            <ColorRow
              label="Tiles: median"
              hint="Halfway to the cutoff (A is amber)"
              value={look.tileMid}
              onChange={(tileMid) => setAppearance({ tileMid })}
            />
            <ColorRow
              label="Tiles: upper"
              hint="At the safety screen's cutoff (A is your Losses color)"
              value={look.tileHigh}
              onChange={(tileHigh) => setAppearance({ tileHigh })}
            />
          </>
        )}
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
            checked={look.learningNote}
            onChange={() => setAppearance({ learningNote: !look.learningNote })}
          />
          &ldquo;Learning from…&rdquo; note under the feed
        </label>
      </fieldset>

      <fieldset>
        <legend>Hide alerts</legend>
        <label className="check">
          <input
            type="checkbox"
            checked={look.hideBelowMcap}
            onChange={() => setAppearance({ hideBelowMcap: !look.hideBelowMcap })}
          />
          Hide alerts on the Live feed whose market cap has fallen below
        </label>
        <McapLine
          value={look.hideBelowMcapUsd}
          on={look.hideBelowMcap}
          onCommit={(hideBelowMcapUsd) => setAppearance({ hideBelowMcapUsd })}
        />
        <p className="faint small check-hint">
          Only hides them from view. Stats, hit rates and grading still count every alert.
        </p>
      </fieldset>

      <fieldset>
        <legend>What cards show</legend>
        <div className="field-groups">
          {CARD_FIELD_GROUPS.map((g) => (
            <div key={g.title} className="field-group">
              <h4>{g.title}</h4>
              {g.fields.map((f) => (
                <label key={f.id} className="check">
                  <input type="checkbox" checked={shown(f.id)} onChange={() => toggleField(f.id)} />
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
        <label className="check">
          <input
            type="checkbox"
            checked={look.scoreColor}
            onChange={() => setAppearance({ scoreColor: !look.scoreColor })}
          />
          Color the score: red for the lowest 10% of recent alerts, green for the top 10%
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={narrativeShown}
            onChange={() => setAppearance({ narrativeNote: !narrativeShown })}
          />
          Narrative model&rsquo;s &ldquo;agrees&rdquo; / &ldquo;warns&rdquo; on other models&rsquo; calls
        </label>
        <p className="faint small check-hint">
          {look.narrativeNote === null ? (
            <>Automatic: {narrativeAutoHint(narrative)}</>
          ) : (
            <>
              Set by you.{" "}
              <button type="button" className="link" onClick={() => setAppearance({ narrativeNote: null })}>
                Go back to automatic
              </button>{" "}
              ({narrativeAutoHint(narrative)})
            </>
          )}
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={look.bubbleCexLinks}
            onChange={() => setAppearance({ bubbleCexLinks: !look.bubbleCexLinks })}
          />
          Bubble maps: tie together wallets funded by the same exchange
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={look.bubbleSideLinks}
            onChange={() => setAppearance({ bubbleSideLinks: !look.bubbleSideLinks })}
          />
          Bubble maps: tie KOLs&apos; possible side wallets to them
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={look.bubbleTransferLinks}
            onChange={() => setAppearance({ bubbleTransferLinks: !look.bubbleTransferLinks })}
          />
          Bubble maps: draw arrows between holders that sent the coin to each other
        </label>
        {/* One switch for the three kinds of name, or each on its own; any set on its own hides the
            one switch here and on the map (user ask 2026-10-16). */}
        {!namesSplit && (
          <label className="check">
            <input
              type="checkbox"
              checked={look.bubbleNameLabels}
              onChange={() => setAppearance({ bubbleNameLabels: !look.bubbleNameLabels })}
            />
            Bubble maps: show Pump.fun, FOMO and Helius names on wallets (KOLs and exchanges always show)
          </label>
        )}
        <div className="check-sub">
          <span className="faint small">
            {namesSplit
              ? "Bubble maps: names on wallets (KOLs and exchanges always show)"
              : "Or set each kind:"}
          </span>
          {NAME_KINDS.map(([key, text]) => (
            <label key={key} className="check">
              <input
                type="checkbox"
                checked={look[key] ?? look.bubbleNameLabels}
                onChange={() => setAppearance({ [key]: !(look[key] ?? look.bubbleNameLabels) })}
              />
              {text}
            </label>
          ))}
          {namesSplit && (
            <button
              type="button"
              className="link small"
              onClick={() =>
                setAppearance({ bubbleNamesPumpfun: null, bubbleNamesFomo: null, bubbleNamesHelius: null })
              }
            >
              Go back to one switch
            </button>
          )}
        </div>
        <div className="field-group">
          <h4>Quick links</h4>
          {QUICK_LINK_SITES.map((l) => (
            <label key={l.id} className="check">
              <input
                type="checkbox"
                checked={look.quickLinks.includes(l.id)}
                onChange={() => toggleQuickLink(l.id)}
              />
              {l.id === "terminal" ? "Trading Terminal (Padre)" : l.label}
            </label>
          ))}
        </div>
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

/** The "hide below" market cap: the slider moves freely and saves when let go. */
function McapLine({ value, on, onCommit }: { value: number; on: boolean; onCommit: (v: number) => void }) {
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
    <label className={`volume mcap-line${on ? "" : " off"}`}>
      <span className="small muted">Market cap</span>
      <input
        ref={ref}
        type="range"
        min={HIDE_BELOW_MCAP.min}
        max={HIDE_BELOW_MCAP.max}
        step={HIDE_BELOW_MCAP.step}
        value={draft}
        aria-label="Hide alerts below this market cap"
        aria-valuetext={`$${draft / 1000}K`}
        onChange={(e) => setDraft(Number(e.target.value))}
      />
      <span className="num small volume-value">${draft / 1000}K</span>
    </label>
  );
}

/** What the automatic Narrative default is doing, and why. */
function narrativeAutoHint(n: NarrativeNoteReadiness | null): string {
  if (!n) return "off until the Narrative model's record loads.";
  const rule = `turns on once the Narrative model's ${n.windowDays}-day 2x hit rate is reliably above ${n.minRatePct}% (the bottom of its 90% range, on at least ${n.minGraded} graded calls), and off once it is reliably below`;
  const range =
    n.lowerPct != null && n.upperPct != null
      ? ` (range ${n.lowerPct.toFixed(0)}-${n.upperPct.toFixed(0)}%)`
      : "";
  const record =
    n.winRatePct === null
      ? "no graded calls yet"
      : `${n.winRatePct.toFixed(0)}%${range} over ${n.graded} graded call${n.graded === 1 ? "" : "s"}`;
  return n.ready ? `on, ${record}. It ${rule}.` : `off for now, ${record}. It ${rule}.`;
}
