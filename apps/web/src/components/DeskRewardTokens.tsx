import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { SearchMarketPatch } from "../cardSearch";
import { deskRewardName, type DeskRewardView } from "../deskRewardDisplay";
import { keptDeskRewardMeta, loadDeskRewardMeta } from "../deskRewardMeta";
import { shortAddress } from "../format";
import { place } from "../touchTips";
import { CheckIcon, CopyIcon } from "./Icons";
import { TokenImage } from "./TokenImage";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function needsMeta(reward: DeskRewardView): boolean {
  const mint = reward.mint?.trim();
  if (!mint || !BASE58.test(mint)) return false;
  return !reward.symbol?.trim() && !reward.name?.trim() && !reward.imageUrl?.startsWith("https://");
}

function mergePatch(reward: DeskRewardView, patch: SearchMarketPatch | undefined): DeskRewardView {
  if (!patch || patch.mint !== reward.mint) return reward;
  return {
    ...reward,
    symbol: reward.symbol ?? patch.symbol,
    name: reward.name ?? patch.name,
    imageUrl: reward.imageUrl ?? patch.imageUrl,
  };
}

function keptPatches(mints: string): Map<string, SearchMarketPatch> {
  const out = new Map<string, SearchMarketPatch>();
  for (const mint of mints ? mints.split(",") : []) {
    const patch = keptDeskRewardMeta(mint);
    if (patch) out.set(mint, patch);
  }
  return out;
}

function useDeskRewardPatches(rewards: readonly DeskRewardView[]): DeskRewardView[] {
  const mints = useMemo(
    () => [...new Set(rewards.filter(needsMeta).map((r) => r.mint!.trim()))].slice(0, 30).join(","),
    [rewards],
  );
  // What the page already has paints at once; a remounted card doesn't ask again (deskRewardMeta.ts).
  const [patches, setPatches] = useState<Map<string, SearchMarketPatch>>(() => keptPatches(mints));
  useEffect(() => {
    if (!mints) return;
    let stop = false;
    void loadDeskRewardMeta(mints.split(",")).then((found) => {
      if (stop || found.size === 0) return;
      setPatches((prev) => {
        const next = new Map(prev);
        for (const [mint, hit] of found) next.set(mint, hit);
        return next;
      });
    });
    return () => {
      stop = true;
    };
  }, [mints]);
  return useMemo(
    () => rewards.map((reward) => mergePatch(reward, reward.mint ? patches.get(reward.mint) : undefined)),
    [rewards, patches],
  );
}

/** The coin's full name for the tooltip's second line, when it says more than the ticker. */
export function deskRewardFullName(reward: DeskRewardView): string | null {
  const name = reward.name?.trim();
  if (!name) return null;
  const ticker = deskRewardName(reward).replace(/^\$/, "");
  return name.toLowerCase() === ticker.toLowerCase() ? null : name;
}

/** What a screen reader says for a coin: "$NVDAx, NVIDIA xStock". */
export function deskRewardAria(reward: DeskRewardView): string {
  const name = deskRewardFullName(reward);
  return name ? `${deskRewardName(reward)}, ${name}` : deskRewardName(reward);
}

/** One or two letters from the ticker, for a coin with no image. */
export function deskRewardMonogram(reward: DeskRewardView): string {
  const ticker = deskRewardName(reward).replace(/^\$/, "");
  return (ticker.match(/[\p{L}\p{N}]/gu) ?? ["?"]).slice(0, 2).join("").toUpperCase();
}

/** A steady hue per ticker, so the same coin's monogram is the same color on every card. */
function monogramHue(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return (h >>> 0) % 360;
}

function RewardAvatar({ reward, px }: { reward: DeskRewardView; px: number }) {
  const mono = deskRewardMonogram(reward);
  return (
    <TokenImage
      url={reward.imageUrl}
      mint={reward.mint}
      size={px * 2}
      className="desk-reward-avatar"
      width={px}
      height={px}
      fallback={
        <span
          className="desk-reward-avatar placeholder"
          style={{ "--mono-hue": monogramHue(mono) } as CSSProperties}
          aria-hidden="true"
        >
          {/* One letter fits a card's small coin; two read better in the larger square and tooltip. */}
          {px < 20 ? mono.slice(0, 1) : mono}
        </span>
      }
    />
  );
}

/** A coin's row in the tooltip: its logo, ticker, name and the shortened CA with a copy button. */
function RewardTipRow({ reward }: { reward: DeskRewardView }) {
  const [copied, setCopied] = useState(false);
  const ticker = deskRewardName(reward);
  const name = deskRewardFullName(reward);
  const mint = reward.mint?.trim();
  const ca = mint && BASE58.test(mint) ? mint : null;
  const copy = () => {
    if (!ca) return;
    void navigator.clipboard?.writeText(ca).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div className="desk-reward-tip-row">
      <RewardAvatar reward={reward} px={28} />
      <div className="desk-reward-tip-text">
        <span className="desk-reward-tip-ticker">{ticker}</span>
        {name && <span className="desk-reward-tip-name">{name}</span>}
        {ca && (
          <span className="desk-reward-tip-ca">
            <a
              className="num"
              href={`https://solscan.io/token/${ca}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {shortAddress(ca)}
            </a>
            <button
              type="button"
              className="desk-reward-copy"
              onClick={copy}
              aria-label={copied ? "Copied" : `Copy ${ticker} contract address`}
              title={copied ? "Copied" : "Copy contract address"}
            >
              {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

/** Close the hover tooltip this long after the pointer leaves, so it can cross into it. */
const CLOSE_DELAY_MS = 140;

/**
 * The tooltip, portaled out of the card (whose overflow would cut it) and placed beside the coin
 * the way a touch tooltip is (touchTips.ts). A scroll, a resize, a tap elsewhere or Escape puts
 * it away.
 */
function RewardTip({
  id,
  rewards,
  host,
  anchor,
  onEnter,
  onLeave,
  onClose,
  focusFirst,
}: {
  id: string;
  rewards: readonly DeskRewardView[];
  host: string;
  anchor: HTMLElement;
  onEnter: () => void;
  onLeave: () => void;
  onClose: (refocus: boolean) => void;
  focusFirst: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) place(anchor, ref.current, window);
  }, [anchor, rewards]);
  useEffect(() => {
    if (focusFirst) ref.current?.querySelector<HTMLElement>("a, button")?.focus();
  }, [focusFirst]);
  useEffect(() => {
    const away = () => onClose(false);
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.contains(t)) return;
      onClose(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose(true);
    window.addEventListener("scroll", away, { capture: true, passive: true });
    window.addEventListener("resize", away);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", away, { capture: true });
      window.removeEventListener("resize", away);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);
  return (
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className="desk-reward-tip"
      onPointerEnter={(e) => e.pointerType === "mouse" && onEnter()}
      onPointerLeave={(e) => e.pointerType === "mouse" && onLeave()}
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        if (next && (ref.current?.contains(next) || anchor.contains(next))) return;
        onClose(false);
      }}
      // Portaled, but React still bubbles its events to the card or Scope row it came from, which
      // open the token view on a click: keep them here.
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="desk-reward-tip-head">
        {host} {rewards.length > 1 ? "rewards" : "reward"}
      </span>
      {rewards.map((reward, index) => (
        <RewardTipRow key={`${reward.mint ?? reward.label}-${index}`} reward={reward} />
      ))}
    </div>
  );
}

type Open = { at: number; how: "hover" | "pinned"; focus: boolean };

/**
 * OTC Desks reward coins as a row of logos (user ask 2026-10-22): the ticker, name and CA are in
 * a tooltip on hover, keyboard focus or a tap, with a copy button for the CA. On a card or Scope
 * row (`compact`) the first `maxVisible` show, tucked behind the gift, then a +N whose tooltip
 * lists the rest; the pro token square shows every coin a little larger.
 */
export function DeskRewardTokens({
  rewards,
  compact = false,
  maxVisible = 3,
  className = "",
  host = "OTC Desks",
}: {
  rewards: readonly DeskRewardView[];
  compact?: boolean;
  /** Who pays these rewards: OTC Desks, or Stonk on a Stonks reward launch. */
  host?: string;
  maxVisible?: number;
  className?: string;
}) {
  const filled = useDeskRewardPatches(rewards);
  const [open, setOpen] = useState<Open | null>(null);
  const anchors = useRef<(HTMLButtonElement | null)[]>([]);
  const timer = useRef<number | null>(null);
  const tipId = useId();
  const clear = () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const refocusing = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;
  // One function for every render, so the open tooltip's listeners aren't swapped on each one.
  const closeRef = useRef((refocus: boolean) => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    const prev = openRef.current;
    setOpen(null);
    if (refocus && prev) {
      // Back on the coin after Escape, without its focus opening the tooltip again.
      refocusing.current = true;
      anchors.current[prev.at]?.focus();
      refocusing.current = false;
    }
  });
  useEffect(() => clear, []);
  if (!filled.length) return null;

  const visible = compact ? filled.slice(0, maxVisible) : filled;
  const rest = compact && filled.length > maxVisible ? filled.slice(maxVisible) : [];
  const count = visible.length + (rest.length ? 1 : 0);
  const close = closeRef.current;
  const leave = () => {
    clear();
    timer.current = window.setTimeout(
      () => setOpen((prev) => (prev?.how === "hover" ? null : prev)),
      CLOSE_DELAY_MS,
    );
  };
  const trigger = (at: number, label: string) => ({
    ref: (el: HTMLButtonElement | null) => {
      anchors.current[at] = el;
    },
    type: "button" as const,
    // An empty title keeps the fee badge's own sentence from showing over the tooltip.
    title: "",
    "aria-label": label,
    "aria-expanded": open?.at === at,
    "aria-describedby": open?.at === at ? tipId : undefined,
    style: { zIndex: count - at },
    onPointerEnter: (e: React.PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      clear();
      setOpen((prev) => (prev?.how === "pinned" ? prev : { at, how: "hover", focus: false }));
    },
    onPointerLeave: (e: React.PointerEvent) => e.pointerType === "mouse" && leave(),
    // Keyboard focus shows it; the focus a click or tap brings is left to the click.
    onFocus: (e: React.FocusEvent<HTMLButtonElement>) => {
      if (!refocusing.current && e.currentTarget.matches(":focus-visible"))
        setOpen({ at, how: "hover", focus: false });
    },
    onBlur: (e: React.FocusEvent) => {
      const next = e.relatedTarget as Element | null;
      if (next?.closest(".desk-reward-tip")) return;
      setOpen((prev) => (prev?.at === at && prev.how === "hover" ? null : prev));
    },
    onKeyDown: (e: React.KeyboardEvent) => e.key === "Escape" && close(false),
    // A click pins it open (a tap on a phone), so the CA can be copied; a second click closes it.
    // Enter or Space also moves focus into it. The card and Scope row skip clicks on buttons.
    onClick: (e: React.MouseEvent) => {
      e.preventDefault();
      clear();
      const keyboard = e.detail === 0;
      setOpen((prev) =>
        prev?.at === at && prev.how === "pinned" ? null : { at, how: "pinned", focus: keyboard },
      );
    },
  });

  const shown = open ? (open.at < visible.length ? visible.slice(open.at, open.at + 1) : rest) : [];
  const anchor = open ? anchors.current[open.at] : null;
  return (
    <span
      className={`desk-reward-tokens${compact ? " compact" : ""}${className ? ` ${className}` : ""}`}
      role="group"
      aria-label={`${host} reward tokens`}
    >
      {visible.map((reward, index) => (
        <button
          key={`${reward.mint ?? reward.label}-${index}`}
          className="desk-reward-coin"
          {...trigger(index, deskRewardAria(reward))}
        >
          <RewardAvatar reward={reward} px={compact ? 16 : 24} />
        </button>
      ))}
      {rest.length > 0 && (
        <button
          className="desk-reward-coin desk-reward-more"
          {...trigger(visible.length, `${rest.length} more: ${rest.map(deskRewardName).join(", ")}`)}
        >
          +{rest.length}
        </button>
      )}
      {open &&
        anchor &&
        shown.length > 0 &&
        createPortal(
          <RewardTip
            id={tipId}
            rewards={shown}
            host={host}
            anchor={anchor}
            onEnter={clear}
            onLeave={() => open.how === "hover" && leave()}
            onClose={close}
            focusFirst={open.focus}
          />,
          // Inside the token view's dialog when it is in one: the dialog sits in the browser's top
          // layer, above anything portaled to the body.
          anchor.closest("dialog") ?? document.body,
        )}
    </span>
  );
}
