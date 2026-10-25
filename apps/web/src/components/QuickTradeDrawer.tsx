import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Card } from "../api";
import { useLiveMarketCaps, useMediaQuery, useNow, usePolling } from "../hooks";
import { change, pct, shortAddress, signedPct, usd } from "../format";
import { summarizePosition, useCanSignTrades, usePosition, useProState } from "../proTrade";
import { openTokenModal } from "../tokenModal";
import { TokenImage } from "./TokenImage";
import { TradePanel } from "./TradePanel";
import { sol, updatedText, type TradeCoin } from "./TradesDrawer";
import { BoltIcon, CheckIcon, ChevronDownIcon, CloseIcon, CopyIcon, ExternalIcon } from "./Icons";

/** Desktop only, as the Trades and Utility panels are. */
const DESKTOP_QUERY = "(min-width: 900px)";
/** The holdings list while the panel is out, and while it is shut after a first look. */
const OPEN_POLL_MS = 20_000;
const SHUT_POLL_MS = 300_000;

/** GET /pro/trades?view=portfolio: the part the picker reads (PortfolioTab has the rest). */
interface Holdings {
  open: TradeCoin[];
  readAt?: string;
}

/**
 * The coins still held, newest bought first: an open trade the chain hasn't emptied. A coin whose
 * sale couldn't be read but the wallet no longer holds is left out, as there is nothing to sell.
 */
export function heldCoins(open: readonly TradeCoin[]): TradeCoin[] {
  return open
    .filter((c) => !c.closed && !(c.mismatch && c.chainHeld === 0))
    .sort((a, b) => Date.parse(b.lastTradeAt) - Date.parse(a.lastTradeAt));
}

const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";

/**
 * A coin's USD price, four significant figures. Past three leading zeros they are counted in a
 * subscript as DEX screens do ("$0.0₅4321" for $0.000004321), so a memecoin's price stays short.
 */
export function coinPriceText(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v <= 0) return "–";
  if (v >= 1000) return `$${Math.round(v).toLocaleString("en-US")}`;
  if (v >= 0.99995) return `$${v.toFixed(v >= 100 ? 2 : 3)}`;
  let zeros = Math.floor(-Math.log10(v));
  let figures = Math.round(v * 10 ** (zeros + 4));
  // 0.099996 rounds up to 0.1000: one zero fewer.
  if (figures >= 10_000) {
    zeros -= 1;
    figures = Math.round(figures / 10);
  }
  const digits = String(figures).replace(/0+$/, "");
  if (zeros < 4) return `$0.${"0".repeat(zeros)}${digits}`;
  const sub = String(zeros)
    .split("")
    .map((d) => SUBSCRIPT[Number(d)])
    .join("");
  return `$0.0${sub}${digits}`;
}

const tone = (n: number | null | undefined) =>
  n === null || n === undefined || n === 0 ? "" : n > 0 ? " up" : " down";

/**
 * The QUICK TRADE panel (user ask 2026-10-25): for a Pro Mode wallet, a handle on the right edge
 * above the Trades one that pulls out a compact trade view of any coin the wallet holds, picked
 * from a dropdown: its price and market, the position and its PnL, and the token window's own
 * Trade panel to buy, sell and set slippage. No chart: the coin's full window is one click away.
 * Desktop only, as the Trades and Utility panels are.
 */
export function QuickTradeDrawer() {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  if (!desktop) return null;
  return <Drawer />;
}

function Drawer() {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  const ref = useRef<HTMLElement>(null);

  // The other two handles step aside while this panel is out (styles.css).
  useEffect(() => {
    if (!open) return;
    document.body.classList.add("qt-open");
    return () => document.body.classList.remove("qt-open");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const aside = ref.current;
    // A popup over the panel (a token modal, the share card) takes Escape and clicks for itself.
    const inPopup = () => document.querySelector("dialog[open]") !== null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !inPopup() && !e.defaultPrevented) {
        setOpen(false);
        aside?.querySelector<HTMLButtonElement>(".qt-drawer-handle")?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target || inPopup() || aside?.contains(target)) return;
      if (target instanceof Element && target.closest("dialog")) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  return (
    <aside ref={ref} className={`qt-drawer${open ? " open" : ""}`} aria-label="Quick Trade panel">
      <button
        type="button"
        className="qt-drawer-handle"
        aria-expanded={open}
        aria-controls="qt-drawer-panel"
        title={open ? "Close Quick Trade" : "Buy or sell any coin you hold"}
        onClick={() => {
          setOpened(true);
          setOpen((o) => !o);
        }}
      >
        <span className="qt-drawer-bolt" aria-hidden="true">
          <BoltIcon size={15} />
        </span>
        <span className="qt-drawer-handle-text">Quick Trade</span>
        <ChevronDownIcon size={15} className="qt-drawer-chev" />
      </button>
      <div id="qt-drawer-panel" className="qt-drawer-panel" inert={!open}>
        {opened && <PanelBody open={open} onClose={() => setOpen(false)} />}
      </div>
    </aside>
  );
}

function PanelBody({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, error } = usePolling<Holdings>(
    "/pro/trades?view=portfolio",
    open ? OPEN_POLL_MS : SHUT_POLL_MS,
  );
  const now = useNow(20_000);
  const coins = useMemo(() => (data ? heldCoins(data.open) : []), [data]);
  const [picked, setPicked] = useState<string | null>(null);
  // The coin picked, while it is still held; else the newest holding.
  const coin = coins.find((c) => c.mint === picked) ?? coins[0] ?? null;

  return (
    <>
      <header className="util-drawer-head qt-drawer-head">
        <div>
          <span className="eyebrow">
            <BoltIcon size={13} /> Quick Trade
          </span>
          <h2>Trade what you hold</h2>
        </div>
        <div className="drawer-actions">
          {data && (
            <span
              className="faint small qt-updated"
              title={data.readAt ? new Date(data.readAt).toLocaleString() : undefined}
            >
              {updatedText(data.readAt, !!error, now)}
            </span>
          )}
          <button type="button" className="ghost icon-btn" onClick={onClose} aria-label="Close Quick Trade">
            <CloseIcon size={16} />
          </button>
        </div>
      </header>
      <div className="qt-drawer-body">
        {error && !data ? (
          <p className="error small" role="alert">
            Couldn&apos;t load your holdings: {error.message}
          </p>
        ) : !data ? (
          <div className="qt-loading" aria-label="Loading your holdings">
            <span className="skeleton qt-skel-picker" />
            <span className="skeleton qt-skel-figs" />
            <span className="skeleton qt-skel-trade" />
          </div>
        ) : coins.length === 0 ? (
          <div className="qt-empty">
            <span className="qt-empty-icon" aria-hidden="true">
              <BoltIcon size={22} />
            </span>
            <strong>Nothing held right now</strong>
            <p className="faint small">
              Buy a coin with this wallet, here or anywhere else, and it shows up here within seconds, ready
              to sell or add to.
            </p>
          </div>
        ) : (
          <>
            <HoldingPicker coins={coins} value={coin!.mint} onPick={setPicked} />
            <CoinTrade key={coin!.mint} coin={coin!} now={now} />
          </>
        )}
      </div>
    </>
  );
}

/** One holding's picture, or its first letters. */
function CoinImage({ coin, px, className }: { coin: TradeCoin; px: number; className: string }) {
  return (
    <TokenImage
      url={coin.imageUrl}
      mint={coin.mint}
      size={px * 2}
      width={px}
      height={px}
      className={className}
      fallback={<span className={`${className} placeholder`}>{(coin.symbol ?? "?").slice(0, 2)}</span>}
    />
  );
}

const coinLabel = (c: TradeCoin) => (c.symbol ? `$${c.symbol}` : shortAddress(c.mint));

/** The holdings dropdown: each coin with its picture, what it is worth and its PnL. */
function HoldingPicker({
  coins,
  value,
  onPick,
}: {
  coins: TradeCoin[];
  value: string;
  onPick: (mint: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const current = coins.find((c) => c.mint === value) ?? coins[0]!;

  useEffect(() => {
    if (!open) return;
    setActive(
      Math.max(
        0,
        coins.findIndex((c) => c.mint === value),
      ),
    );
    list.current?.focus();
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
    // Opening picks the active row once; a poll while it is open keeps the row the reader moved to.
  }, [open]);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const choose = (mint: string) => {
    onPick(mint);
    setOpen(false);
    button.current?.focus();
  };

  const onListKey = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown") setActive((i) => Math.min(coins.length - 1, i + 1));
    else if (e.key === "ArrowUp") setActive((i) => Math.max(0, i - 1));
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(coins.length - 1);
    else if (e.key === "Enter" || e.key === " ") choose(coins[active]!.mint);
    else if (e.key === "Escape") {
      // Prevented below, so the panel's own Escape leaves it open: this one only shuts the list.
      setOpen(false);
      button.current?.focus();
    } else if (e.key === "Tab") setOpen(false);
    else return;
    if (e.key !== "Tab") e.preventDefault();
  };

  return (
    <div ref={wrap} className={`qt-picker${open ? " open" : ""}`}>
      <span className="qt-picker-label" id={`${id}-label`}>
        Your holdings <span className="qt-picker-count">{coins.length}</span>
      </span>
      <button
        ref={button}
        type="button"
        className="qt-picker-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${id}-label ${id}-value`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <CoinImage coin={current} px={30} className="qt-coin-img" />
        <span className="qt-picker-main" id={`${id}-value`}>
          <strong>{coinLabel(current)}</strong>
          {current.name && <span className="faint">{current.name}</span>}
        </span>
        <PnlChip coin={current} />
        <ChevronDownIcon size={16} className="qt-picker-chev" />
      </button>
      {open && (
        <ul
          ref={list}
          className="qt-picker-list"
          role="listbox"
          tabIndex={-1}
          aria-labelledby={`${id}-label`}
          aria-activedescendant={`${id}-opt-${active}`}
          onKeyDown={onListKey}
        >
          {coins.map((c, i) => (
            <li
              key={c.mint}
              id={`${id}-opt-${i}`}
              data-i={i}
              role="option"
              aria-selected={c.mint === value}
              className={`qt-picker-opt${i === active ? " active" : ""}${c.mint === value ? " chosen" : ""}`}
              onPointerEnter={() => setActive(i)}
              onClick={() => choose(c.mint)}
            >
              <CoinImage coin={c} px={28} className="qt-coin-img" />
              <span className="qt-picker-main">
                <strong>{coinLabel(c)}</strong>
                <span className="faint num">
                  {usd(c.card?.currentMarketCapUsd ?? null)} MC · {sol(c.spentSol)} in
                </span>
              </span>
              <PnlChip coin={c} />
              <span className="qt-picker-tick" aria-hidden="true">
                {c.mint === value && <CheckIcon size={14} />}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PnlChip({ coin }: { coin: TradeCoin }) {
  if (coin.pnlPct === null) return <span className="qt-pnl-chip num">–</span>;
  return <span className={`qt-pnl-chip num${tone(coin.pnlPct)}`}>{signedPct(coin.pnlPct)}</span>;
}

/** The picked coin: its figures, then the Trade panel with the position, buy, sell and slippage. */
function CoinTrade({ coin, now }: { coin: TradeCoin; now: number }) {
  const pro = useProState();
  const owner = pro?.wallet ?? null;
  const canSign = useCanSignTrades(owner);
  const position = usePosition(owner ? coin.mint : null);
  // The coin's market cap, ticked live while it is picked (the token window's own reading).
  const cards = useMemo(() => (coin.card ? [coin.card] : undefined), [coin.card]);
  const live = useLiveMarketCaps(cards)?.[0] ?? null;
  const card: Card | null = live ?? coin.card;
  const mcap = card?.currentMarketCapUsd ?? null;
  const mcapAt = card?.currentMarketCapAt ? Date.parse(card.currentMarketCapAt) : null;
  const summary = useMemo(
    () => (position.data ? summarizePosition(position.data, mcap) : null),
    [position.data, mcap],
  );
  const snap = card?.latestSnapshot ?? card?.snapshot ?? null;
  const decimals = position.data?.decimals ?? null;
  const supply =
    position.data?.supply && decimals !== null ? Number(BigInt(position.data.supply)) / 10 ** decimals : null;
  // The price from the live market cap over the supply; else the last scan's own, scaled to it.
  const price =
    mcap !== null && supply
      ? mcap / supply
      : snap?.priceUsd && snap.marketCapUsd && mcap !== null
        ? (snap.priceUsd * mcap) / snap.marketCapUsd
        : (snap?.priceUsd ?? null);
  const move = change(coin.entryMcapUsd, mcap);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(coin.mint).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    });
  };
  const closeOnly = !!pro && !pro.pro;

  return (
    <section className="qt-coin" aria-label={`Trade ${coinLabel(coin)}`}>
      <div className="qt-coin-head">
        <div
          className={`avatar-wrap tone-${coin.pnlPct === null ? "neutral" : coin.pnlPct >= 0 ? "good" : "bad"}`}
        >
          <CoinImage coin={coin} px={42} className="avatar qt-coin-avatar" />
        </div>
        <div className="qt-coin-title">
          <h3 title={coin.name ?? undefined}>
            {coinLabel(coin)}
            {coin.name && coin.symbol && <span className="faint">{coin.name}</span>}
          </h3>
          <button type="button" className="link small num qt-coin-ca" onClick={copy} title="Copy the CA">
            {shortAddress(coin.mint)} {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
          </button>
        </div>
        {card && (
          <button
            type="button"
            className="ghost small qt-coin-full"
            onClick={() => openTokenModal(card, now)}
            title="Open its token window: chart, holders and bubble map"
          >
            Full view <ExternalIcon size={12} />
          </button>
        )}
      </div>

      <dl className="qt-figs">
        <div>
          <dt>Price</dt>
          <dd className="num">{coinPriceText(price)}</dd>
        </div>
        <div>
          <dt>Market cap</dt>
          <dd className="num">
            {usd(mcap)}
            {move !== null && (
              <small className={`qt-move${move >= 0 ? " up" : " down"}`} title="Since your average entry">
                {move >= 0 ? "▲" : "▼"} {pct(Math.abs(move))}
              </small>
            )}
          </dd>
        </div>
        <div>
          <dt>Liquidity</dt>
          <dd className="num">{usd(snap?.liquidityUsd ?? null)}</dd>
        </div>
        <div>
          <dt>Vol 24h</dt>
          <dd className="num">{usd(snap?.volume24hUsd ?? null)}</dd>
        </div>
      </dl>

      {owner && canSign ? (
        // The token window's terminal rail lays the Trade panel out for a column this narrow.
        <div className="tm-term-rail qt-trade">
          <TradePanel
            owner={owner}
            mint={coin.mint}
            symbol={coin.symbol ?? "tokens"}
            name={coin.name}
            position={position.data}
            positionStaleAt={position.error && position.data ? position.at : null}
            summary={summary}
            nowMcap={mcap}
            nowMcapAt={mcapAt}
            onTraded={position.reload}
            closeOnly={closeOnly}
            graceEndsAt={pro?.pro ? pro.graceEndsAt : null}
          />
        </div>
      ) : owner ? (
        <p className="notice small">
          The wallet you signed in with ({shortAddress(owner)}) isn&apos;t available in this browser, so a
          trade can&apos;t be signed here. Open TrenchScanner where that wallet is to trade it.
        </p>
      ) : null}
    </section>
  );
}
