import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  api,
  type Card,
  type ExternalSearchAnswer,
  type TokenSearchAnswer,
  type TokenSearchHit,
} from "../api";
import { parseSearch } from "../caSearch";
import type { SearchMarketPatch } from "../cardSearch";
import { useLiveMarketCaps, useMediaQuery, useNow, usePolling } from "../hooks";
import { change, pct, shortAddress, signedPct, usd } from "../format";
import { summarizePosition, useCanSignTrades, usePosition, useProState } from "../proTrade";
import { openTokenModal } from "../tokenModal";
import { TokenImage } from "./TokenImage";
import { TradePanel } from "./TradePanel";
import { sol, updatedText, type TradeCoin } from "./TradesDrawer";
import { BoltIcon, CheckIcon, ChevronDownIcon, CloseIcon, CopyIcon, ExternalIcon, LinkIcon } from "./Icons";

/** Desktop only, as the Trades and Utility panels are. */
const DESKTOP_QUERY = "(min-width: 900px)";
/** The holdings list while the panel is out, and while it is shut after a first look. */
const OPEN_POLL_MS = 20_000;
const SHUT_POLL_MS = 300_000;
/** A pasted coin's market, read again while it is shown (the server reuses a minute-old reading). */
const PASTED_POLL_MS = 20_000;

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
 * The coin the panel trades: a holding, or one pasted by its CA. A tracked coin has its feed card
 * (a live market cap and the Full view); any other has the market a search read for it.
 */
interface Subject {
  mint: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  card: Card | null;
  market: Pick<SearchMarketPatch, "marketCapUsd" | "marketCapAt" | "liquidityUsd" | "volume24hUsd"> | null;
  entryMcapUsd: number | null;
  pnlPct: number | null;
}

function holdingSubject(c: TradeCoin): Subject {
  return { ...c, market: null };
}

/** The address in what was pasted or typed (a bare CA, or a link to a token page), else null. */
export function pastedMint(text: string): string | null {
  const q = parseSearch(text);
  return q.kind === "mint" ? q.mint : null;
}

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
  const [caText, setCaText] = useState("");
  // A whole CA in the box loads that coin; one the wallet holds is picked from the holdings instead.
  const pasted = pastedMint(caText);
  const pastedHolding = pasted ? (coins.find((c) => c.mint === pasted) ?? null) : null;
  // The coin picked, while it is still held; else the newest holding.
  const coin = pastedHolding ?? coins.find((c) => c.mint === picked) ?? coins[0] ?? null;
  const pick = (mint: string) => {
    setPicked(mint);
    setCaText("");
  };

  return (
    <>
      <header className="util-drawer-head qt-drawer-head">
        <div>
          <span className="eyebrow">
            <BoltIcon size={13} /> Quick Trade
          </span>
          <h2>Trade any coin, fast</h2>
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
        <CaBox text={caText} onText={setCaText} loaded={pasted !== null} />
        {pasted && !pastedHolding ? (
          <PastedCoin key={pasted} mint={pasted} now={now} />
        ) : error && !data ? (
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
              Paste a CA above to buy a coin. Anything this wallet buys, here or anywhere else, shows up in
              your holdings within seconds, ready to sell or add to.
            </p>
          </div>
        ) : (
          <>
            <HoldingPicker coins={coins} value={coin!.mint} onPick={pick} />
            <CoinTrade key={coin!.mint} coin={holdingSubject(coin!)} now={now} />
          </>
        )}
      </div>
    </>
  );
}

/** The CA box: paste or type a contract address (or a token page's link) and the coin loads. */
function CaBox({ text, onText, loaded }: { text: string; onText: (t: string) => void; loaded: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const typed = text.trim() !== "";
  const paste = async () => {
    setNote(null);
    try {
      const clip = (await navigator.clipboard.readText()).trim();
      if (!clip) return setNote("Your clipboard is empty.");
      onText(clip);
      if (!pastedMint(clip)) setNote("That isn't a contract address.");
    } catch {
      // The browser wouldn't share the clipboard: the reader pastes into the box instead.
      setNote("Your browser blocked reading the clipboard: paste into the box instead.");
      input.current?.focus();
    }
  };
  return (
    <div className={`qt-ca${loaded ? " loaded" : ""}`}>
      <label className="qt-picker-label" htmlFor="qt-ca-input">
        Trade by CA
      </label>
      <div className="qt-ca-row">
        <span className="qt-ca-field">
          <LinkIcon size={14} className="qt-ca-icon" />
          <input
            ref={input}
            id="qt-ca-input"
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="Paste a contract address"
            value={text}
            onChange={(e) => {
              setNote(null);
              onText(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && typed) {
                e.preventDefault();
                onText("");
              }
            }}
          />
          {typed && (
            <button
              type="button"
              className="ghost icon-btn qt-ca-clear"
              onClick={() => {
                setNote(null);
                onText("");
                input.current?.focus();
              }}
              aria-label="Clear the CA"
              title="Back to your holdings"
            >
              <CloseIcon size={13} />
            </button>
          )}
        </span>
        <button type="button" className="qt-ca-paste" onClick={() => void paste()}>
          Paste
        </button>
      </div>
      {note ? (
        <p className="faint small qt-ca-note">{note}</p>
      ) : (
        typed && !loaded && <p className="faint small qt-ca-note">Keep going: a whole CA loads the coin.</p>
      )}
    </div>
  );
}

/**
 * A coin pasted by its CA: what TrenchScanner tracks of it (its feed card, for a live market cap
 * and the Full view), else DexScreener's market from the search window's outside search. A coin
 * neither knows can still be bought: the trade is refused when built if it isn't a token.
 */
function PastedCoin({ mint, now }: { mint: string; now: number }) {
  const [found, setFound] = useState<
    | { state: "loading" }
    | { state: "done"; hit: TokenSearchHit | null; card: Card | null; tracked: boolean }
    | { state: "error"; message: string }
  >({ state: "loading" });
  const [market, setMarket] = useState<SearchMarketPatch | null>(null);

  useEffect(() => {
    let live = true;
    const q = `mint=${encodeURIComponent(mint)}`;
    void (async () => {
      try {
        const tracked = (await api<TokenSearchAnswer>(`/tokens/search?${q}`)).hits.find(
          (h) => h.mint === mint,
        );
        const card = tracked ? await api<Card>(`/tokens/${mint}/card`).catch(() => null) : null;
        const hit =
          tracked ??
          (await api<ExternalSearchAnswer>(`/utilities/search?${q}`)
            .then((a) => a.hits.find((h) => h.mint === mint) ?? null)
            .catch(() => null));
        if (live) setFound({ state: "done", hit, card, tracked: !!tracked });
      } catch (e) {
        if (live) setFound({ state: "error", message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      live = false;
    };
  }, [mint]);

  // An untracked coin's market, kept current while it is shown (a tracked one ticks live).
  const poll = found.state === "done" && !found.card;
  useEffect(() => {
    if (!poll) return;
    const read = () => {
      if (document.visibilityState !== "visible") return;
      api<{ hits: SearchMarketPatch[] }>(`/tokens/search/markets?mints=${encodeURIComponent(mint)}`)
        .then((a) => setMarket(a.hits.find((h) => h.mint === mint) ?? null))
        .catch(() => undefined);
    };
    const id = window.setInterval(read, PASTED_POLL_MS);
    return () => window.clearInterval(id);
  }, [poll, mint]);

  if (found.state === "loading")
    return (
      <div className="qt-loading" aria-label="Loading the coin">
        <span className="skeleton qt-skel-figs" />
        <span className="skeleton qt-skel-trade" />
      </div>
    );
  if (found.state === "error")
    return (
      <p className="error small" role="alert">
        Couldn&apos;t look up {shortAddress(mint)}: {found.message}
      </p>
    );
  const { hit, card } = found;
  const read = market ?? hit;
  const subject: Subject = {
    mint,
    symbol: card?.token.symbol ?? hit?.symbol ?? null,
    name: card?.token.name ?? hit?.name ?? null,
    imageUrl: card?.token.imageUrl ?? (hit?.imageUrl?.startsWith("https://") ? hit.imageUrl : null),
    card,
    market: read,
    entryMcapUsd: null,
    pnlPct: null,
  };
  return (
    <>
      {!found.tracked && (
        <p className="faint small qt-pasted-note">
          {hit
            ? "Not tracked by TrenchScanner: no alerts or model calls on it. Its market is DexScreener's."
            : "DexScreener has no market for this address yet. A coin minutes old can still be bought; anything that isn't a token is refused when the trade is built."}
        </p>
      )}
      <CoinTrade coin={subject} now={now} />
    </>
  );
}

type CoinFace = Pick<Subject, "mint" | "symbol" | "imageUrl">;

/** A coin's picture, or its first letters. */
function CoinImage({ coin, px, className }: { coin: CoinFace; px: number; className: string }) {
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

const coinLabel = (c: Pick<Subject, "mint" | "symbol">) => (c.symbol ? `$${c.symbol}` : shortAddress(c.mint));

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
function CoinTrade({ coin, now }: { coin: Subject; now: number }) {
  const pro = useProState();
  const owner = pro?.wallet ?? null;
  const canSign = useCanSignTrades(owner);
  const position = usePosition(owner ? coin.mint : null);
  // The coin's market cap, ticked live while it is picked (the token window's own reading).
  const cards = useMemo(() => (coin.card ? [coin.card] : undefined), [coin.card]);
  const live = useLiveMarketCaps(cards)?.[0] ?? null;
  const card: Card | null = live ?? coin.card;
  const mcap = card?.currentMarketCapUsd ?? coin.market?.marketCapUsd ?? null;
  const mcapIso = card ? card.currentMarketCapAt : coin.market?.marketCapAt;
  const mcapAt = mcapIso ? Date.parse(mcapIso) : null;
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
          <dd className="num">{usd(snap?.liquidityUsd ?? coin.market?.liquidityUsd ?? null)}</dd>
        </div>
        <div>
          <dt>Vol 24h</dt>
          <dd className="num">{usd(snap?.volume24hUsd ?? coin.market?.volume24hUsd ?? null)}</dd>
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
