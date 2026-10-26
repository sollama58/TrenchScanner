import { useState } from "react";
import { LinkSwatch } from "./GraphView";
import { SWITCH_LABEL, WALLET_SWITCHES, type AsylEdgeKind, type WalletSwitch } from "./graph";

/**
 * What can be done to many bubbles at once, once a box, a lasso or Ctrl-clicks picked them (user
 * ask 2026-10-25): take them off, keep only them, hold them in place, find the links among them,
 * and switch their own kinds of link, all together. With coins in the pick, the coin actions run
 * on every picked coin at once (user ask 2026-10-26): Show holders, live or not, and Show deployers.
 */

/** How much of the pick something holds for: all of it, some of it, or none. */
export type Share = "all" | "some" | "none";

export interface PickSwitch {
  kind: WalletSwitch;
  /** Links of this kind that reach the picked wallets. */
  count: number;
  /** How many of the picked wallets have it switched off. */
  off: Share;
}

export function PickBar({
  wallets,
  tokens,
  switches,
  pinned,
  busy,
  onHide,
  onKeepOnly,
  onPin,
  onLinksAmong,
  onGrow,
  onSwitch,
  onClear,
  chainOff,
  onShowHolders,
  onShowDeployers,
  onCommonFunder,
}: {
  wallets: number;
  tokens: number;
  switches: PickSwitch[];
  pinned: Share;
  busy: boolean;
  onHide: () => void;
  onKeepOnly: () => void;
  onPin: (hold: boolean) => void;
  onLinksAmong: () => void;
  onGrow: () => void;
  onSwitch: (kind: WalletSwitch, on: boolean) => void;
  onClear: () => void;
  /** Why live chain reads can't run now (no Pro Mode, credits used up), or null when they can. */
  chainOff?: string | null;
  onShowHolders?: (live: boolean) => void;
  onShowDeployers?: () => void;
  /** The nearest wallet that paid for two or more of the picked wallets. */
  onCommonFunder?: () => void;
}) {
  // Show holders reads the current lists live from the chain (Pro), as the reader last left it.
  const [live, setLive] = useState(false);
  const canLive = !chainOff;
  const count = wallets + tokens;
  const parts = [
    wallets ? `${wallets} wallet${wallets === 1 ? "" : "s"}` : "",
    tokens ? `${tokens} coin${tokens === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  const order = WALLET_SWITCHES.filter((k) => switches.some((s) => s.kind === k));
  return (
    <div className="asyl-pick-bar" role="toolbar" aria-label={`${count} picked`}>
      <div className="asyl-pick-head">
        <b>{count} picked</b>
        <span className="asyl-muted">{parts.join(" · ")}</span>
        <button className="asyl-icon-btn" onClick={onClear} aria-label="Let the pick go" title="Let go (Esc)">
          ×
        </button>
      </div>
      <div className="asyl-pick-actions">
        <button
          className="asyl-btn"
          onClick={onHide}
          title="Take them all off the map (Del); Undo or Z brings them back"
        >
          Hide
        </button>
        <button className="asyl-btn ghost" onClick={onKeepOnly} title="Take everything else off the map">
          Keep only these
        </button>
        <button
          className={`asyl-btn ghost${pinned === "all" ? " on" : ""}`}
          aria-pressed={pinned === "all"}
          onClick={() => onPin(pinned !== "all")}
          title={
            pinned === "all"
              ? "They hold where they are; click to let the layout move them again"
              : "Hold them where they are, so the layout doesn't move them"
          }
        >
          {pinned === "all" ? "📌 Held" : "📌 Hold in place"}
        </button>
        <button
          className="asyl-btn ghost"
          onClick={onLinksAmong}
          disabled={busy || wallets === 0 || count < 2}
          title="Every stored link between the picked wallets and coins, free of credits"
        >
          Links among them
        </button>
        {onCommonFunder && (
          <button
            className="asyl-btn ghost"
            onClick={onCommonFunder}
            disabled={busy || wallets < 2}
            title="The nearest wallet that paid for two or more of the picked wallets, up their stored funding, free of credits"
          >
            Common funder
          </button>
        )}
        <button
          className="asyl-btn ghost"
          onClick={onGrow}
          title="Add the bubbles linked to them to the pick"
        >
          ＋ Linked
        </button>
      </div>
      {tokens > 0 && (onShowHolders || onShowDeployers) && (
        <div className="asyl-pick-actions" role="group" aria-label="The picked coins">
          <span className="asyl-muted asyl-small">{tokens === 1 ? "The coin" : `The ${tokens} coins`}</span>
          {onShowHolders && (
            <>
              <button
                className="asyl-btn ghost"
                disabled={busy}
                title="Everyone holding them now and everyone who held them before, as your cutoffs keep them"
                onClick={() => onShowHolders(live && canLive)}
              >
                Show holders
              </button>
              <label
                className="asyl-check"
                title={chainOff ?? "Reads who holds each right now from the chain, up to 130 credits a coin"}
              >
                <input
                  type="checkbox"
                  checked={live && canLive}
                  disabled={!canLive}
                  onChange={(e) => setLive(e.target.checked)}
                />{" "}
                Live <span className="asyl-pro-chip">Pro</span>
              </label>
            </>
          )}
          {onShowDeployers && (
            <button
              className="asyl-btn ghost"
              disabled={busy}
              title="Who deployed each picked coin, with a link from deployer to coin"
              onClick={onShowDeployers}
            >
              Show deployers
            </button>
          )}
        </div>
      )}
      {order.length > 0 && (
        <div className="asyl-pick-kinds" role="group" aria-label="The picked wallets' kinds of link">
          <span className="asyl-muted asyl-small">Their links</span>
          {order.map((k) => {
            const s = switches.find((x) => x.kind === k)!;
            const on = s.off === "none";
            return (
              <button
                key={k}
                className={`asyl-chip${on ? " on" : ""}${s.off === "some" ? " some" : ""}`}
                aria-pressed={on ? true : s.off === "some" ? "mixed" : false}
                title={
                  on
                    ? `Hide their ${SWITCH_LABEL[k]} links, for these wallets only`
                    : `Show their ${SWITCH_LABEL[k]} links again${s.off === "some" ? " (some have them off)" : ""}`
                }
                onClick={() => onSwitch(k, !on)}
              >
                <LinkSwatch kind={k.startsWith("transfer:") ? "transfer" : (k as AsylEdgeKind)} />
                {SWITCH_LABEL[k]}
                <span className="asyl-count">{s.count}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
