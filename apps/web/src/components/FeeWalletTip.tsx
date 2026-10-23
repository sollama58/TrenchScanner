import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { holderRewardTaxLabel, type FeeRecipientShare } from "./AlertCard";
import { WalletIcon } from "./Icons";
import { KolAvatar } from "./KolAvatar";
import { place } from "../touchTips";

/** Close the hover tooltip this long after the pointer leaves, so it can cross into it. */
const CLOSE_DELAY_MS = 140;

/** The recipients whose wallet is a KOL with a picture, for the photos beside the wallet icon. */
export function kolPictures(
  recipients: readonly FeeRecipientShare[] | null | undefined,
): FeeRecipientShare[] {
  return (recipients ?? []).filter((r) => r.kol && r.avatar);
}

/** A KOL's picture as a small round mark; a letter when the picture fails to load. */
export function FeeKolAvatar({ recipient, px }: { recipient: FeeRecipientShare; px: number }) {
  const letter = (recipient.name ?? recipient.label).trim().charAt(0).toUpperCase() || "?";
  return (
    <span className="fee-kol" style={{ width: px, height: px }} title="">
      <KolAvatar
        src={recipient.avatar}
        className="fee-kol-img"
        fallback={<span className="fee-kol-letter">{letter}</span>}
      />
    </span>
  );
}

/**
 * Who a wallet-fee coin pays (user ask 2026-10-23): one row per wallet, its name when
 * TrenchScanner knows it (a KOL with their picture), the address, and its share.
 */
function WalletTipBody({ head, recipients }: { head: string; recipients: readonly FeeRecipientShare[] }) {
  return (
    <>
      <span className="desk-reward-tip-head">{head}</span>
      {recipients.map((r, i) => {
        const pct = holderRewardTaxLabel(r.bps);
        return (
          <div className="fee-wallet-tip-row" key={`${r.label}-${i}`}>
            {r.kol && r.avatar ? (
              <FeeKolAvatar recipient={r} px={28} />
            ) : (
              <span className="fee-wallet-tip-icon" aria-hidden="true">
                <WalletIcon size={15} />
              </span>
            )}
            <span className="desk-reward-tip-text">
              <span className="desk-reward-tip-ticker">
                {r.name ?? r.label}
                {r.kol && <span className="fee-wallet-tip-tag">KOL</span>}
              </span>
              {r.name && <span className="desk-reward-tip-name num">{r.label}</span>}
            </span>
            {pct && <span className="fee-wallet-tip-pct num">{pct}</span>}
          </div>
        );
      })}
    </>
  );
}

/**
 * A styled tooltip over `children` listing a wallet fee's recipients, portaled out of the card
 * (whose overflow would cut it). Hover or keyboard focus shows it; a tap pins it. A scroll, a
 * resize, a tap elsewhere or Escape puts it away. With no recipients, `fallback` is the native
 * title instead.
 */
export function FeeWalletTip({
  recipients,
  head = "Creator fees go to",
  fallback,
  className = "",
  children,
}: {
  recipients: readonly FeeRecipientShare[] | null | undefined;
  head?: string;
  fallback: string;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState<"hover" | "pinned" | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const id = useId();
  const list = recipients?.length ? recipients : null;
  const clear = () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const leave = () => {
    clear();
    timer.current = window.setTimeout(() => setOpen((o) => (o === "hover" ? null : o)), CLOSE_DELAY_MS);
  };
  useEffect(() => clear, []);
  useLayoutEffect(() => {
    if (open && anchor.current && tip.current) place(anchor.current, tip.current, window);
  }, [open, list]);
  useEffect(() => {
    if (!open) return;
    const away = () => setOpen(null);
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (tip.current?.contains(t) || anchor.current?.contains(t)) return;
      setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
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
  }, [open]);
  if (!list) {
    return (
      <span className={className} title={fallback}>
        {children}
      </span>
    );
  }
  return (
    <span
      ref={anchor}
      className={`fee-wallet-anchor${className ? ` ${className}` : ""}`}
      tabIndex={0}
      role="button"
      aria-label={fallback}
      aria-expanded={open !== null}
      aria-describedby={open ? id : undefined}
      onPointerEnter={(e) => {
        if (e.pointerType !== "mouse") return;
        clear();
        setOpen((o) => o ?? "hover");
      }}
      onPointerLeave={(e) => e.pointerType === "mouse" && leave()}
      onFocus={(e) => e.currentTarget.matches(":focus-visible") && setOpen((o) => o ?? "hover")}
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        if (next && tip.current?.contains(next)) return;
        setOpen((o) => (o === "hover" ? null : o));
      }}
      // A tap pins it (a phone has no hover); the card under it does not open.
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        clear();
        setOpen((o) => (o === "pinned" ? null : "pinned"));
      }}
    >
      {children}
      {open &&
        anchor.current &&
        createPortal(
          <div
            ref={tip}
            id={id}
            role="tooltip"
            className="desk-reward-tip fee-wallet-tip"
            onPointerEnter={(e) => e.pointerType === "mouse" && clear()}
            onPointerLeave={(e) => e.pointerType === "mouse" && open === "hover" && leave()}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <WalletTipBody head={head} recipients={list} />
          </div>,
          // Inside the token view's dialog when it is in one: the dialog sits in the top layer.
          anchor.current.closest("dialog") ?? document.body,
        )}
    </span>
  );
}
