import { useEffect, useState } from "react";
import {
  BUY_PRESETS_PER_ROW,
  DEFAULT_TRADE_SETTINGS,
  MAX_CUSTOM_FEE_SOL,
  MIN_TRADE_SOL,
  MIN_TIP_SOL,
  QUICK_BUY_COLORS,
  QUICK_BUY_POSITIONS,
  quickBuyAmountOk,
  saveTradeSettings,
  useProState,
  useTradeSettings,
  withSellAll,
  type QuickBuySettings,
  type TradeSettings,
} from "../proTrade";
import { parseDecimal } from "../decimal";
import { PresetButtonsEditor } from "./PresetButtonsEditor";
import { presetCols, sellCols } from "./TradePanel";
import { Switch } from "./AlertDeliveryPanels";
import { BoltIcon } from "./Icons";

/**
 * Customize › Trading (user ask 2026-10-18): the Trade panel's defaults in one place, plus the
 * quick-buy pill for alert and stream cards. Shown only to a wallet with Pro Mode. Synced to the
 * account and shared live with every open Trade panel (useTradeSettings).
 */

const POSITION_LABEL: Record<QuickBuySettings["position"], string> = {
  "top-right": "Top right",
  "top-left": "Top left",
  "bottom-right": "Bottom right",
  "bottom-left": "Bottom left",
};
const SIZE_LABEL: Record<QuickBuySettings["size"], string> = { s: "Small", m: "Medium", l: "Large" };

/** A new buy button: double the biggest, rounded, within 0.01 to 100 SOL. */
export function nextBuy(values: number[]): number {
  const top = Math.max(0, ...values);
  return top > 0 ? Math.min(100, Math.round(top * 2 * 100) / 100) : 0.1;
}

/** A new sell button: the first common share not there yet. */
export function nextSell(values: number[]): number {
  return [50, 25, 75, 10, 33, 90].find((p) => !values.includes(p)) ?? 20;
}

/** The quick-buy amount as the field shows it: blank when none is set. */
export function quickAmountText(amountSol: number): string {
  return quickBuyAmountOk(amountSol) ? String(amountSol) : "";
}

export function TradingSettingsPanel({ embedded = false }: { embedded?: boolean }) {
  const pro = useProState();
  const settings = useTradeSettings();
  if (!pro?.pro) return null;
  return <Panel settings={settings} embedded={embedded} />;
}

function Panel({ settings, embedded }: { settings: TradeSettings; embedded: boolean }) {
  const update = (patch: Partial<TradeSettings>) => saveTradeSettings({ ...settings, ...patch });
  const updateQuick = (patch: Partial<QuickBuySettings>) =>
    update({ quickBuy: { ...settings.quickBuy, ...patch } });
  const q = settings.quickBuy;
  const [quickAmount, setQuickAmount] = useState(quickAmountText(q.amountSol));
  // A change from another device or tab (or Reset) shows in the box too.
  useEffect(() => setQuickAmount(quickAmountText(q.amountSol)), [q.amountSol]);
  const maxBuys = BUY_PRESETS_PER_ROW * settings.buyRows;
  // One row holds five: going back to one row keeps the first five.
  const setRows = (rows: 1 | 2) =>
    update({ buyRows: rows, buyPresets: settings.buyPresets.slice(0, BUY_PRESETS_PER_ROW * rows) });

  const Tag = embedded ? "div" : "section";
  return (
    <Tag className={embedded ? "trading-settings embedded" : "panel trading-settings"}>
      <header className="section-head">
        <div>
          {!embedded && (
            <span className="eyebrow">
              <BoltIcon size={13} /> Trading
            </span>
          )}
          {embedded ? <h4>Trade defaults</h4> : <h2>Trade defaults</h2>}
        </div>
        <button
          type="button"
          className="button ghost small"
          onClick={() => saveTradeSettings(DEFAULT_TRADE_SETTINGS)}
        >
          Reset
        </button>
      </header>
      <p className="muted small">
        Used by the Trade section under the token chart and by quick buy. Saved to your account, so every
        device you sign in on trades the same way.
      </p>

      <div className="preset-editor-head">
        <h3 className="trading-sub">Buttons under the chart</h3>
        <div className="segmented small" role="radiogroup" aria-label="Rows of buy buttons">
          {([1, 2] as const).map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={settings.buyRows === r}
              className={settings.buyRows === r ? "on" : ""}
              onClick={() => setRows(r)}
            >
              {r === 1 ? "1 row" : "2 rows"}
            </button>
          ))}
        </div>
      </div>
      <p className="muted small">
        As they look in the Trade section. Tap a button to change its amount, × to remove it.
      </p>
      <div className="tm-trade-sides preset-editors">
        <PresetButtonsEditor
          side="buy"
          values={settings.buyPresets}
          unit="SOL"
          min={MIN_TRADE_SOL}
          max={100}
          maxCount={maxBuys}
          grid={presetCols(settings.buyPresets.length, settings.buyRows)}
          hint="with SOL"
          suggest={(v) => nextBuy(v)}
          onChange={(next) => update({ buyPresets: next })}
        />
        <PresetButtonsEditor
          side="sell"
          values={settings.sellPresets}
          unit="%"
          min={1}
          max={99}
          maxCount={6}
          minCount={0}
          grid={sellCols(settings.sellPresets.length)}
          hint="% of the position"
          locked={(v) => v >= 100}
          suggest={(v) => nextSell(v)}
          onChange={(next) => update({ sellPresets: withSellAll(next) })}
        />
      </div>

      <h3 className="trading-sub">Execution</h3>
      <div className="trading-grid">
        <label className="trading-field">
          <span className="small muted">Slippage, %</span>
          <input
            inputMode="decimal"
            autoComplete="off"
            key={settings.slippagePct}
            defaultValue={settings.slippagePct}
            onBlur={(e) => {
              const v = parseDecimal(e.target.value);
              const ok = v !== null && v >= 0.1 && v <= 50;
              if (ok) update({ slippagePct: v });
              e.target.value = String(ok ? v : settings.slippagePct);
            }}
          />
        </label>
        <div className="trading-field">
          <span className="small muted">Speed</span>
          <div className="segmented small" role="radiogroup" aria-label="Speed">
            {(["eco", "turbo"] as const).map((sp) => (
              <button
                key={sp}
                type="button"
                role="radio"
                aria-checked={settings.speed === sp}
                className={settings.speed === sp ? "on" : ""}
                onClick={() => update({ speed: sp })}
              >
                {sp === "eco" ? "Eco" : "Turbo"}
              </button>
            ))}
          </div>
        </div>
        <div className="trading-field">
          <span className="small muted">Priority fee</span>
          <div className="segmented small" role="radiogroup" aria-label="Priority fee">
            {(["auto", "custom"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={settings.priorityMode === m}
                className={settings.priorityMode === m ? "on" : ""}
                onClick={() => update({ priorityMode: m })}
              >
                {m === "auto" ? "Auto" : "Custom"}
              </button>
            ))}
          </div>
        </div>
        {settings.priorityMode === "custom" && (
          <label className="trading-field">
            <span className="small muted">Custom priority fee, SOL (up to {MAX_CUSTOM_FEE_SOL})</span>
            <input
              inputMode="decimal"
              autoComplete="off"
              key={settings.customPrioritySol}
              defaultValue={settings.customPrioritySol}
              onBlur={(e) => {
                const v = parseDecimal(e.target.value);
                const ok = v !== null && v >= 0 && v <= MAX_CUSTOM_FEE_SOL;
                if (ok) update({ customPrioritySol: v });
                e.target.value = String(ok ? v : settings.customPrioritySol);
              }}
            />
          </label>
        )}
        <label className="trading-field">
          <span className="small muted">Tip, SOL (blank for the minimum, {MIN_TIP_SOL[settings.speed]})</span>
          <input
            inputMode="decimal"
            autoComplete="off"
            placeholder={String(MIN_TIP_SOL[settings.speed])}
            key={settings.customTipSol ?? "min"}
            defaultValue={settings.customTipSol ?? ""}
            onBlur={(e) => {
              if (e.target.value.trim() === "") return update({ customTipSol: null });
              const v = parseDecimal(e.target.value);
              const ok = v !== null && v > 0 && v <= MAX_CUSTOM_FEE_SOL;
              if (ok) update({ customTipSol: v });
              e.target.value = ok
                ? String(v)
                : settings.customTipSol === null
                  ? ""
                  : String(settings.customTipSol);
            }}
          />
        </label>
        <label className="trading-check small">
          <input
            type="checkbox"
            checked={settings.mevProtect}
            onChange={(e) => update({ mevProtect: e.target.checked })}
          />
          <span>MEV shield (keeps trades away from validators known for sandwich attacks)</span>
        </label>
      </div>

      <h3 className="trading-sub">Coins you hold</h3>
      <div className="tab-option">
        <Switch
          on={settings.alwaysShowHeld}
          label="Always show coins you hold"
          onToggle={() => update({ alwaysShowHeld: !settings.alwaysShowHeld })}
        />
        <p className="muted small">
          A coin in your wallet stays on Cards and Scope even when your filters, the market cap line or Hide
          would take it off. It still sits in its usual column and place, and only while it would normally be
          on the feed.
        </p>
      </div>

      <h3 className="trading-sub">Quick buy on cards</h3>
      <div className="tab-option">
        <Switch on={q.enabled} label="Quick buy" onToggle={() => updateQuick({ enabled: !q.enabled })} />
        <p className="muted small">
          A buy button on every alert and Stream card. One tap buys the amount below with these settings, and
          your wallet still asks before anything is sent.
        </p>
      </div>
      {q.enabled && (
        <div className="trading-grid">
          <label className="trading-field">
            <span className="small muted">Amount per tap, SOL (from {MIN_TRADE_SOL})</span>
            <input
              inputMode="decimal"
              autoComplete="off"
              placeholder="Set an amount to show it"
              value={quickAmount}
              onChange={(e) => setQuickAmount(e.target.value)}
              onBlur={() => {
                // Blank or 0 clears the amount, which hides the button on cards (user ask 2026-10-19).
                const v = quickAmount.trim() === "" ? 0 : parseDecimal(quickAmount);
                const next = v === 0 ? 0 : quickBuyAmountOk(v) ? v : q.amountSol;
                if (next !== q.amountSol) updateQuick({ amountSol: next });
                setQuickAmount(quickAmountText(next));
              }}
            />
          </label>
          <div className="trading-field">
            <span className="small muted">Where on the card</span>
            <div className="segmented small wrap" role="radiogroup" aria-label="Where the quick buy sits">
              {QUICK_BUY_POSITIONS.map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={q.position === p}
                  className={q.position === p ? "on" : ""}
                  onClick={() => updateQuick({ position: p })}
                >
                  {POSITION_LABEL[p]}
                </button>
              ))}
            </div>
          </div>
          <div className="trading-field">
            <span className="small muted">Size</span>
            <div className="segmented small" role="radiogroup" aria-label="Quick buy size">
              {(["s", "m", "l"] as const).map((z) => (
                <button
                  key={z}
                  type="button"
                  role="radio"
                  aria-checked={q.size === z}
                  className={q.size === z ? "on" : ""}
                  onClick={() => updateQuick({ size: z })}
                >
                  {SIZE_LABEL[z]}
                </button>
              ))}
            </div>
          </div>
          <div className="trading-field">
            <span className="small muted">Color</span>
            <div className="qb-swatches" role="radiogroup" aria-label="Quick buy color">
              {QUICK_BUY_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={q.color === c}
                  aria-label={c}
                  title={c}
                  className={`qb-swatch qb-${c}${q.color === c ? " on" : ""}`}
                  onClick={() => updateQuick({ color: c })}
                />
              ))}
            </div>
          </div>
          <div className="trading-field">
            <span className="small muted">Preview</span>
            <span className="qb-preview">
              <span className={`quick-buy qb-inline qb-${q.size} qb-${q.color}`}>
                <BoltIcon size={q.size === "s" ? 10 : q.size === "l" ? 14 : 12} />
                <span className="num">{quickBuyAmountOk(q.amountSol) ? `${q.amountSol} SOL` : "—"}</span>
              </span>
              {!quickBuyAmountOk(q.amountSol) && (
                <span className="small muted">Hidden on cards until an amount is set</span>
              )}
            </span>
          </div>
        </div>
      )}
    </Tag>
  );
}
