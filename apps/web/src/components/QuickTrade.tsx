import { useEffect, useMemo, useRef, useState } from "react";
import type { ExternalSearchHit } from "../api";
import { pumpFunHref, QUICK_LINK_SITES } from "../appearance";
import { ago, shortAddress, usd } from "../format";
import { summarizePosition, useCanSignTrades, usePosition, useProState } from "../proTrade";
import { PRO_MODE_PERKS } from "./ProModeCard";
import { TokenImage } from "./TokenImage";
import { TradePanel } from "./TradePanel";
import { CheckIcon, CloseIcon, CopyIcon, CrownIcon } from "./Icons";

/**
 * What the window says in place of the coin's figures when DexScreener gave none: still asking,
 * couldn't be asked (worth another try), or lists no market for it.
 */
export function marketNote(searching: boolean, searchError: string | null): string {
  if (searching) return "Reading its market on DexScreener…";
  if (searchError !== null) return `Couldn't read its market on DexScreener: ${searchError}`;
  return "DexScreener has no market for this address yet. A coin minutes old can still be bought; anything that isn't a token is refused when the trade is built.";
}

/**
 * A coin TrenchScanner doesn't track, opened to trade it (user ask 2026-10-19: someone pasting a
 * CA we don't track most likely wants to trade it). Free and quick: the Trade panel for a Pro Mode
 * wallet, what DexScreener's search already said about the coin, and links to trade it elsewhere.
 * The full view (chart, holders, bubble map, TokenSage's read) is the Utilities tab's coin lookup,
 * offered at its price here; it is free once the wallet has traded the coin (lookupGate.ts).
 *
 * Nothing here adds an outside call of its own: the figures are the search's, and the Trade
 * panel's reads are the ones every token window's makes.
 */
export function QuickTrade({
  mint,
  hit,
  searching,
  searchError,
  onSearchAgain,
  scanPrice,
  scanning,
  scanError,
  onScan,
  onClose,
  now,
}: {
  mint: string;
  /** DexScreener's answer for the coin: null while it is asked, or when it lists no pair yet. */
  hit: ExternalSearchHit | null;
  /** DexScreener is still being asked. */
  searching: boolean;
  /** Why DexScreener couldn't be asked (not the same as it listing nothing); null when it answered. */
  searchError: string | null;
  onSearchAgain: () => void;
  /** What the full lookup costs this wallet ("1 credit", "Free, you traded it"). */
  scanPrice: string;
  scanning: boolean;
  scanError: string | null;
  onScan: () => void;
  onClose: () => void;
  now: number;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const pro = useProState();
  const owner = pro?.wallet ?? null;
  const canSign = useCanSignTrades(owner);
  const position = usePosition(owner ? mint : null);
  const holds = !!position.data && BigInt(position.data.balance) > 0n;
  // Pro Mode ended: selling what the wallet holds only, as in the token window.
  const closeOnly = !!pro && !pro.pro;
  const trading = !!owner && canSign && (!closeOnly || holds);
  const mcap = hit?.marketCapUsd ?? null;
  const summary = useMemo(
    () => (position.data ? summarizePosition(position.data, mcap) : null),
    [position.data, mcap],
  );
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const label = hit?.symbol ? `$${hit.symbol}` : (hit?.name ?? shortAddress(mint));
  const copy = () => {
    void navigator.clipboard?.writeText(mint).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    });
  };
  const links = [
    ...QUICK_LINK_SITES.map((s) => ({ id: s.id, label: s.label, href: s.href(mint) })),
    { id: "pumpfun", label: "Pump.fun", href: pumpFunHref(mint) },
    { id: "dexscreener", label: "DexScreener", href: `https://dexscreener.com/solana/${mint}` },
  ];

  return (
    <dialog
      ref={ref}
      className="about-modal sheet-modal quick-trade-modal"
      aria-labelledby="qt-title"
      onClose={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) ref.current?.close();
      }}
    >
      <div className="about-body quick-trade">
        <header className="about-head quick-trade-head">
          <TokenImage
            url={hit?.imageUrl?.startsWith("https://") ? hit.imageUrl : null}
            mint={hit?.mint}
            size={80}
            width={40}
            height={40}
            className="search-hit-img"
            fallback={<span className="search-hit-img placeholder">{(hit?.symbol ?? "?").slice(0, 2)}</span>}
          />
          <div className="quick-trade-title">
            <h3 id="qt-title" tabIndex={-1}>
              {label}
              {hit?.name && hit.symbol && <span className="search-hit-name">{hit.name}</span>}
            </h3>
            <button
              type="button"
              className="link small num quick-trade-ca"
              onClick={copy}
              title="Copy the CA"
            >
              {shortAddress(mint)} {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
            </button>
          </div>
          <button className="ghost icon-btn" onClick={() => ref.current?.close()} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </header>

        {hit ? (
          <dl className="quick-trade-figs">
            <div>
              <dt>MC</dt>
              <dd className="num">{usd(hit.marketCapUsd)}</dd>
            </div>
            <div>
              <dt>Liquidity</dt>
              <dd className="num">{usd(hit.liquidityUsd)}</dd>
            </div>
            <div>
              <dt>Vol 24h</dt>
              <dd className="num">{usd(hit.volume24hUsd)}</dd>
            </div>
            <div>
              <dt>Listed</dt>
              <dd className="num">{ago(hit.launchedAt, now)}</dd>
            </div>
          </dl>
        ) : (
          <p className="muted small">
            {marketNote(searching, searchError)}
            {!searching && searchError !== null && (
              <>
                {" "}
                <button type="button" className="link small" onClick={onSearchAgain}>
                  Try again
                </button>
              </>
            )}
          </p>
        )}
        <p className="muted small">Not tracked by TrenchScanner: no alerts or model calls on it.</p>

        {trading && owner ? (
          <TradePanel
            owner={owner}
            mint={mint}
            symbol={hit?.symbol ?? "tokens"}
            name={hit?.name ?? null}
            position={position.data}
            positionStaleAt={position.error && position.data ? position.at : null}
            summary={summary}
            nowMcap={mcap}
            nowMcapAt={hit?.marketCapAt ? Date.parse(hit.marketCapAt) : null}
            onTraded={position.reload}
            closeOnly={closeOnly}
            graceEndsAt={pro?.pro ? pro.graceEndsAt : null}
          />
        ) : owner && !canSign && (pro?.pro || holds) ? (
          <p className="notice small">
            The wallet you signed in with ({shortAddress(owner)}) isn&apos;t available in this browser, so a
            trade can&apos;t be signed here. Open TrenchScanner where that wallet is, or use a link below.
          </p>
        ) : (
          <section className="sage-card tm-term-pro" aria-label="Pro Mode">
            <h4>
              <CrownIcon size={14} /> Trade here with Pro Mode
            </h4>
            <ul>
              {PRO_MODE_PERKS.slice(0, 3).map((p) => (
                <li key={p.title}>
                  <b>{p.title}.</b> <span className="muted">{p.text}</span>
                </li>
              ))}
            </ul>
            <a className="tm-term-pro-go" href="#settings" onClick={() => ref.current?.close()}>
              See Pro Mode in Settings
            </a>
          </section>
        )}

        <div className="quick-trade-links" aria-label="Trade it elsewhere">
          {links.map((l) => (
            <a key={l.id} className="quick-trade-link" href={l.href} target="_blank" rel="noreferrer">
              {l.label}
            </a>
          ))}
        </div>

        <div className="quick-trade-scan">
          <div>
            <strong>Full scan</strong>
            <p className="muted small">
              Its chart, holders, bubble map, safety checks and TokenSage&apos;s read, and TrenchScanner keeps
              scanning it.
              {!scanPrice.startsWith("Free") && " Free once you've traded it."}
            </p>
          </div>
          <button
            type="button"
            className="primary small-btn"
            onClick={onScan}
            disabled={scanning || searching}
          >
            {scanning ? "Scanning…" : `Scan it · ${scanPrice}`}
          </button>
        </div>
        {scanError && <p className="error small">Couldn&apos;t scan it: {scanError}</p>}
      </div>
    </dialog>
  );
}
