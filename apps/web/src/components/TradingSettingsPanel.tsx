import { useState } from "react";
import {
  BUY_PRESETS_PER_ROW,
  DEFAULT_TRADE_SETTINGS,
  MAX_CUSTOM_FEE_SOL,
  MIN_TRADE_SOL,
  MIN_TIP_SOL,
  QUICK_BUY_COLORS,
  QUICK_BUY_POSITIONS,
  saveTradeSettings,
  useProState,
  useTradeSettings,
  type QuickBuySettings,
  type TradeSettings,
} from "../proTrade";
import { Switch } from "./AlertDeliveryPanels";
import { BoltIcon } from "./Icons";

/**
 * Settings > Trading (user ask 2026-10-18): the Trade panel's defaults in one place, plus the
 * quick-buy pill for alert and stream cards. Shown only to a wallet with Pro Mode. Kept in this
 * browser, shared live with every open Trade panel (useTradeSettings).
 */

const POSITION_LABEL: Record<QuickBuySettings["position"], string> = {
  "top-right": "Top right",
  "top-left": "Top left",
  "bottom-right": "Bottom right",
  "bottom-left": "Bottom left",
};
const SIZE_LABEL: Record<QuickBuySettings["size"], string> = { s: "Small", m: "Medium", l: "Large" };

/** "0.1, 0.25 0.5" -> [0.1, 0.25, 0.5]: amounts from `min` (above 0) up to `max`, at most `count` of them. */
export function parseAmounts(text: string, max: number, count: number, min = 0): number[] {
  return text
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0 && n >= min && n <= max)
    .slice(0, count);
}

export function TradingSettingsPanel() {
  const pro = useProState();
  const settings = useTradeSettings();
  if (!pro?.pro) return null;
  return <Panel settings={settings} />;
}

function Panel({ settings }: { settings: TradeSettings }) {
  const update = (patch: Partial<TradeSettings>) => saveTradeSettings({ ...settings, ...patch });
  const updateQuick = (patch: Partial<QuickBuySettings>) =>
    update({ quickBuy: { ...settings.quickBuy, ...patch } });
  const q = settings.quickBuy;
  // Typed text, so a half-typed list isn't rewritten under the cursor; saved on leaving the field.
  const [buys, setBuys] = useState(settings.buyPresets.join(", "));
  const [sells, setSells] = useState(settings.sellPresets.join(", "));
  const [quickAmount, setQuickAmount] = useState(String(q.amountSol));
  const maxBuys = BUY_PRESETS_PER_ROW * settings.buyRows;

  const saveBuys = (rows = settings.buyRows) => {
    const list = parseAmounts(buys, 100, BUY_PRESETS_PER_ROW * rows, MIN_TRADE_SOL);
    const next = list.length > 0 ? list : settings.buyPresets.slice(0, BUY_PRESETS_PER_ROW * rows);
    setBuys(next.join(", "));
    update({ buyPresets: next, buyRows: rows });
  };

  return (
    <section className="panel trading-settings">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <BoltIcon size={13} /> Trading
          </span>
          <h2>Trade defaults</h2>
        </div>
        <button
          type="button"
          className="button ghost small"
          onClick={() => {
            saveTradeSettings(DEFAULT_TRADE_SETTINGS);
            setBuys(DEFAULT_TRADE_SETTINGS.buyPresets.join(", "));
            setSells(DEFAULT_TRADE_SETTINGS.sellPresets.join(", "));
            setQuickAmount(String(DEFAULT_TRADE_SETTINGS.quickBuy.amountSol));
          }}
        >
          Reset
        </button>
      </header>
      <p className="muted small">
        Used by the Trade section under the token chart and by quick buy. Saved in this browser.
      </p>

      <h3 className="trading-sub">Buy buttons under the chart</h3>
      <div className="trading-grid">
        <label className="trading-field">
          <span className="small muted">
            Amounts, SOL (from {MIN_TRADE_SOL}, up to {maxBuys})
          </span>
          <input value={buys} onChange={(e) => setBuys(e.target.value)} onBlur={() => saveBuys()} />
        </label>
        <div className="trading-field">
          <span className="small muted">Rows</span>
          <div className="segmented small" role="radiogroup" aria-label="Rows of buy buttons">
            {([1, 2] as const).map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={settings.buyRows === r}
                className={settings.buyRows === r ? "on" : ""}
                onClick={() => saveBuys(r)}
              >
                {r === 1 ? "1 row" : "2 rows"}
              </button>
            ))}
          </div>
        </div>
        <label className="trading-field">
          <span className="small muted">Sell buttons, % of the position (up to 6)</span>
          <input
            value={sells}
            onChange={(e) => setSells(e.target.value)}
            onBlur={() => {
              const list = parseAmounts(sells, 100, 6);
              const next = list.length > 0 ? list : settings.sellPresets;
              setSells(next.join(", "));
              update({ sellPresets: next });
            }}
          />
        </label>
      </div>

      <h3 className="trading-sub">Execution</h3>
      <div className="trading-grid">
        <label className="trading-field">
          <span className="small muted">Slippage, %</span>
          <input
            type="number"
            inputMode="decimal"
            min={0.1}
            max={50}
            step={0.5}
            defaultValue={settings.slippagePct}
            onBlur={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 0.1 && v <= 50) update({ slippagePct: v });
              else e.target.value = String(settings.slippagePct);
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
              type="number"
              inputMode="decimal"
              min={0}
              max={MAX_CUSTOM_FEE_SOL}
              step={0.00001}
              defaultValue={settings.customPrioritySol}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= 0 && v <= MAX_CUSTOM_FEE_SOL) update({ customPrioritySol: v });
                else e.target.value = String(settings.customPrioritySol);
              }}
            />
          </label>
        )}
        <label className="trading-field">
          <span className="small muted">Tip, SOL (blank for the minimum, {MIN_TIP_SOL[settings.speed]})</span>
          <input
            type="number"
            inputMode="decimal"
            min={MIN_TIP_SOL[settings.speed]}
            max={MAX_CUSTOM_FEE_SOL}
            step={0.00001}
            placeholder={String(MIN_TIP_SOL[settings.speed])}
            defaultValue={settings.customTipSol ?? ""}
            onBlur={(e) => {
              if (e.target.value.trim() === "") return update({ customTipSol: null });
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v > 0 && v <= MAX_CUSTOM_FEE_SOL) update({ customTipSol: v });
              else e.target.value = settings.customTipSol === null ? "" : String(settings.customTipSol);
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
              type="number"
              inputMode="decimal"
              min={MIN_TRADE_SOL}
              max={100}
              step={0.05}
              value={quickAmount}
              onChange={(e) => setQuickAmount(e.target.value)}
              onBlur={() => {
                const v = Number(quickAmount);
                if (Number.isFinite(v) && v >= MIN_TRADE_SOL && v <= 100) updateQuick({ amountSol: v });
                else setQuickAmount(String(q.amountSol));
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
                <span className="num">{q.amountSol} SOL</span>
              </span>
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
