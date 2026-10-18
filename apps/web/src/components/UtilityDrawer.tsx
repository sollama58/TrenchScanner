import { useEffect, useRef, useState } from "react";
import { usePolling } from "../hooks";
import { shortAddress } from "../format";
import { openWallet } from "../walletModal";
import {
  CreditBurn,
  DailyFreeLine,
  LookupCard,
  LookupWhat,
  creditCount,
  plural,
  SYMBOL,
  UtilityTokenModal,
  type UtilitiesOverview,
} from "../tabs/UtilitiesTab";
import { ArrowRightIcon, ChevronDownIcon, CloseIcon, FlameIcon, ToolsIcon } from "./Icons";

/** Wide enough for the panel's three columns; phones and narrow windows don't get it (user ask). */
const DESKTOP_QUERY = "(min-width: 900px)";

function useMatches(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const sync = () => setMatches(list.matches);
    sync();
    list.addEventListener("change", sync);
    return () => list.removeEventListener("change", sync);
  }, [query]);
  return matches;
}

/**
 * The utility panel (user ask 2026-10-16): a "UTILS" handle on the right edge of every tab that
 * pulls out the Utilities tab's coin and wallet scanners, each with the lookups still free to
 * re-open, and the Burn Credits balance with its refill. The scanners, the result views and the
 * burn are the Utilities tab's own. Desktop only: below DESKTOP_QUERY nothing is drawn.
 */
export function UtilityDrawer({ walletAddress, onMore }: { walletAddress: string; onMore: () => void }) {
  const desktop = useMatches(DESKTOP_QUERY);
  if (!desktop) return null;
  return <Drawer walletAddress={walletAddress} onMore={onMore} />;
}

function Drawer({ walletAddress, onMore }: { walletAddress: string; onMore: () => void }) {
  const [open, setOpen] = useState(false);
  // The panel's reads start the first time it opens, and it keeps what was typed after that.
  const [opened, setOpened] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const toggle = () => {
    setOpened(true);
    setOpen((o) => !o);
  };

  // The Trades handle steps aside while this panel is out, so it never sits over it (styles.css).
  useEffect(() => {
    if (!open) return;
    document.body.classList.add("util-open");
    return () => document.body.classList.remove("util-open");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const aside = ref.current;
    // Into the coin scanner's box, ready for a paste.
    const first = panelRef.current?.querySelector<HTMLInputElement>("input");
    const focusTimer = setTimeout(() => first?.focus({ preventScroll: true }), 60);
    // A popup over the panel (a scan's result, the refill) takes Escape and clicks for itself.
    const inPopup = () => document.querySelector("dialog[open]") !== null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !inPopup()) {
        setOpen(false);
        aside?.querySelector<HTMLButtonElement>(".util-drawer-handle")?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target || inPopup() || aside?.contains(target)) return;
      // A dialog that just closed under the pointer is not the page.
      if (target instanceof Element && target.closest("dialog")) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  return (
    <aside ref={ref} className={`util-drawer${open ? " open" : ""}`} aria-label="Utilities panel">
      <button
        type="button"
        className="util-drawer-handle"
        aria-expanded={open}
        aria-controls="util-drawer-panel"
        title={open ? "Close the utilities" : "Coin and wallet scanners, Burn Credits"}
        onClick={toggle}
      >
        <ToolsIcon size={19} />
        <span className="util-drawer-handle-text">Utility</span>
        <ChevronDownIcon size={16} className="util-drawer-chev" />
      </button>
      <div id="util-drawer-panel" className="util-drawer-panel" ref={panelRef} inert={!open}>
        {opened && (
          <DrawerBody
            walletAddress={walletAddress}
            onClose={() => setOpen(false)}
            onMore={() => {
              setOpen(false);
              onMore();
            }}
          />
        )}
      </div>
    </aside>
  );
}

type Lookup = UtilitiesOverview["lookups"][number];

/** Minutes left of a lookup's free re-open window; 0 once it has passed. */
function freeMinutesLeft(l: Lookup, reopenMinutes: number, now: number): number {
  const left = reopenMinutes - (now - new Date(l.at).getTime()) / 60_000;
  return left > 0 ? Math.ceil(left) : 0;
}

/** The open lookups of one kind, newest first, each subject once. */
function openLookups(data: UtilitiesOverview | null, utility: "token" | "wallet", now: number): Lookup[] {
  if (!data) return [];
  const seen = new Set<string>();
  return data.lookups.filter((l) => {
    if (l.utility !== utility || !l.subject || !l.open || seen.has(l.subject)) return false;
    if (freeMinutesLeft(l, data.reopenMinutes, now) === 0) return false;
    seen.add(l.subject);
    return true;
  });
}

function DrawerBody({
  walletAddress,
  onClose,
  onMore,
}: {
  walletAddress: string;
  onClose: () => void;
  onMore: () => void;
}) {
  const { data, error, reload } = usePolling<UtilitiesOverview>("/utilities", 60_000);
  const [openMint, setOpenMint] = useState<string | null>(null);
  const [refill, setRefill] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(id);
  }, []);

  const openToken = (mint: string) => setOpenMint(mint);

  return (
    <>
      <header className="util-drawer-head">
        <div>
          <span className="eyebrow">
            <ToolsIcon size={13} /> Utilities
          </span>
          <h2>Scan a coin or a wallet</h2>
        </div>
        <div className="drawer-actions">
          <button type="button" className="ghost small-btn" onClick={onMore}>
            Utilities tab <ArrowRightIcon size={12} />
          </button>
          <button type="button" className="ghost icon-btn" onClick={onClose} aria-label="Close the utilities">
            <CloseIcon size={16} />
          </button>
        </div>
      </header>
      {error && !data && (
        <p className="error small util-drawer-error" role="alert">
          Couldn&apos;t load your utilities: {error.message}
        </p>
      )}
      <div className="util-drawer-grid">
        <ScannerColumn
          utility="token"
          data={data}
          now={now}
          onOpened={(mint) => {
            openToken(mint);
            reload();
          }}
          onOpen={openToken}
          empty="Coins you scan stay here, free to reopen, for an hour."
        />
        <ScannerColumn
          utility="wallet"
          data={data}
          now={now}
          onOpened={(wallet) => {
            openWallet(wallet);
            reload();
          }}
          onOpen={openWallet}
          empty="Wallets you scan stay here, free to reopen, for an hour."
        />
        <CreditsColumn data={data} onRefill={() => setRefill(true)} />
      </div>
      {openMint && (
        <UtilityTokenModal
          key={openMint}
          mint={openMint}
          lookups={data?.lookups}
          onClose={() => {
            setOpenMint(null);
            reload();
          }}
        />
      )}
      {data && (
        <RefillModal
          open={refill}
          walletAddress={walletAddress}
          data={data}
          onClose={() => setRefill(false)}
          onCredited={reload}
        />
      )}
    </>
  );
}

/** One scanner: the Utilities tab's lookup form, then the lookups of its kind still free to reopen. */
function ScannerColumn({
  utility,
  data,
  now,
  onOpened,
  onOpen,
  empty,
}: {
  utility: "token" | "wallet";
  data: UtilitiesOverview | null;
  now: number;
  onOpened: (address: string) => void;
  onOpen: (address: string) => void;
  empty: string;
}) {
  const recents = openLookups(data, utility, now);
  return (
    <section className="util-col">
      <LookupCard utility={utility} data={data} onOpened={onOpened} compact />
      <div className="util-col-recent">
        <h4 className="util-col-label">
          Recent <span className="faint">· free to reopen</span>
        </h4>
        {!data ? (
          <p className="faint small">Loading…</p>
        ) : recents.length === 0 ? (
          <p className="faint small">{empty}</p>
        ) : (
          <ul className="util-list util-drawer-list">
            {recents.map((l) => (
              <li key={l.subject}>
                <button
                  type="button"
                  className="util-recent-row"
                  onClick={() => onOpen(l.subject!)}
                  title={`Open ${l.subject}`}
                >
                  <LookupWhat
                    lookup={l}
                    detail={
                      <>
                        {shortAddress(l.subject!)} · free for {freeMinutesLeft(l, data.reopenMinutes, now)}m
                      </>
                    }
                  />
                  <ArrowRightIcon size={13} className="util-recent-go" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** The Burn Credits balance and what a lookup costs, with the refill behind a button. */
function CreditsColumn({ data, onRefill }: { data: UtilitiesOverview | null; onRefill: () => void }) {
  return (
    <section className="util-col util-col-credits">
      <header className="util-col-head">
        <h3>
          <FlameIcon size={14} /> Burn Credits
        </h3>
      </header>
      <div className="util-balance" aria-live="polite">
        {data ? (
          <>
            <span className="num">{creditCount(data.balance)}</span>
            <small className="muted">credit{data.balance === 1 ? "" : "s"}</small>
          </>
        ) : (
          <span className="num muted">–</span>
        )}
      </div>
      {data && <DailyFreeLine daily={data.daily} />}
      {data && (
        <dl className="util-drawer-rates">
          <div>
            <dt>Coin scan</dt>
            <dd className="num">{plural(data.prices.cost.token, "credit")}</dd>
          </div>
          <div>
            <dt>Wallet scan</dt>
            <dd className="num">{plural(data.prices.cost.wallet, "credit")}</dd>
          </div>
          <div>
            <dt>Tracked coin or wallet</dt>
            <dd className="util-free-rate">Free</dd>
          </div>
          <div>
            <dt>1 credit</dt>
            <dd className="num">
              {data.prices.tokensPerCredit.toLocaleString("en-US")} {SYMBOL}
            </dd>
          </div>
        </dl>
      )}
      <button type="button" className="primary util-refill" disabled={!data} onClick={onRefill}>
        <FlameIcon size={14} /> Refill credits
      </button>
      <p className="faint small util-col-note">
        A credit is only taken once a scan works, and each scan reopens free for {data?.reopenMinutes ?? 60}{" "}
        minutes.
      </p>
    </section>
  );
}

/** Burning for more credits, in a popup over the panel: the Utilities tab's own burn. */
function RefillModal({
  open,
  walletAddress,
  data,
  onClose,
  onCredited,
}: {
  open: boolean;
  walletAddress: string;
  data: UtilitiesOverview;
  onClose: () => void;
  onCredited: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Mounted from the first open on, so a burn in flight carries on (and is credited) if the popup
  // is closed while it finalises.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const dialog = ref.current;
    if (open) setShown(true);
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="about-modal sheet-modal util-refill-modal"
      aria-labelledby="util-refill-title"
      onClose={(e) => {
        // Only this dialog's own close: a nested dialog's close bubbles up through React.
        if (e.target === e.currentTarget) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="about-body">
        <header className="about-head">
          <h2 id="util-refill-title">
            <FlameIcon size={18} /> Refill Burn Credits
          </h2>
          <button className="ghost icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </header>
        <p className="muted small">
          You have <strong className="num">{plural(data.balance, "credit")}</strong>. Each credit burns{" "}
          {data.prices.tokensPerCredit.toLocaleString("en-US")} {SYMBOL} from this wallet, and they show here
          as soon as Solana finalises the burn.
        </p>
        {shown && <CreditBurn walletAddress={walletAddress} overview={data} onCredited={onCredited} />}
      </div>
    </dialog>
  );
}
