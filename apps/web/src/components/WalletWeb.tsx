import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cachedGet } from "../cache";
import { shortAddress } from "../format";
import { openWallet } from "../walletModal";
import { useWalletNames, walletNameText, type WalletNames } from "../walletNames";
import {
  layoutWeb,
  TIE_LABEL,
  tieText,
  walletCount,
  WEB_TIES,
  type PlacedEdge,
  type PlacedNode,
  type SideWeb,
  type WebTie,
} from "../walletWeb";
import { renderWalletWebCard } from "../walletWebCard";
import { LoadingNote } from "./Loading";
import { ShareButton } from "./ShareImageDialog";
import { BubblesIcon, CheckIcon, CloseIcon, CopyIcon, WalletIcon } from "./Icons";

/**
 * The wallet web (user ask 2026-10-16): a bubble map of every wallet labeled for a KOL (or that
 * any other wallet's bundle would label), each tied to the wallet it is linked to by the kind of
 * link that labeled it: a Known Side, a funding, buying the same coins, or coins moved between
 * them. The headline is the number of wallets used. Opened from a KOL's row on the Side Wallet
 * Checker and from the labeled wallets above any side-wallet list.
 */

/** GET /utilities/side-web/:wallet, cached like the bundle read it may reuse. */
function webRead(wallet: string): Promise<SideWeb> {
  return cachedGet<SideWeb>(`/utilities/side-web/${encodeURIComponent(wallet)}`, 10 * 60_000);
}

/** The bubble button that opens a wallet's web. */
export function WalletWebButton({
  wallet,
  name,
  className = "ghost icon-btn side-profile",
  children,
}: {
  wallet: string;
  name: string;
  className?: string;
  /** A labelled button; a bare icon when absent. */
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={className}
        title={`Map ${name}'s wallet web`}
        aria-label={children ? undefined : `Map ${name}'s wallet web`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <BubblesIcon size={15} />
        {children}
      </button>
      {open &&
        createPortal(
          <WalletWebModal wallet={wallet} name={name} onClose={() => setOpen(false)} />,
          document.body,
        )}
    </>
  );
}

/** Each kind of bubble's colour, as a CSS custom property name (styles.css .ww-modal). */
function nodeTone(n: PlacedNode): string {
  if (n.role === "hub") return "hub";
  if (n.role === "known") return "known";
  if (n.role === "funded") return "funded";
  if (n.role === "funder") return "funder";
  return n.moverOnly ? "transfers" : "trades";
}
const TONES = ["hub", "known", "funded", "funder", "trades", "transfers"] as const;

function nodeName(n: PlacedNode, names: WalletNames, hubName: string): string {
  if (n.role === "hub") return hubName;
  const named = names[n.wallet];
  if (named) return walletNameText(named);
  if (n.role === "funder") return `Funder ${shortAddress(n.wallet)}`;
  return n.name ?? shortAddress(n.wallet);
}

const ROLE_PILL: Record<PlacedNode["role"], string> = {
  hub: "Main wallet",
  known: "Known Side",
  funded: "KOL Funded Wallet",
  possible: "Possible Side",
  bundle: "Would be labeled",
  funder: "Shared funder",
};

/** What a bubble carries inside it: % shared, transfers, SOL paid, or nothing. */
function innerText(n: PlacedNode, edges: readonly PlacedEdge[]): string | null {
  if (n.role === "hub" || n.role === "funder") return null;
  if (n.role === "known") return "own";
  if (n.role === "funded") {
    const sol = edges.find((e) => e.type === "funded" && e.to === n.wallet)?.sol;
    return sol ? `${sol >= 10 ? sol.toFixed(0) : sol.toFixed(1)}◎` : "paid";
  }
  if (n.pct > 0) return `${Math.round(n.pct)}%`;
  return n.transfers ? `${n.transfers}×` : null;
}

export function WalletWebModal({
  wallet,
  name,
  onClose,
}: {
  wallet: string;
  name: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [web, setWeb] = useState<SideWeb | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  useEffect(() => {
    let live = true;
    setError(null);
    webRead(wallet)
      .then((w) => live && setWeb(w))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [wallet, attempt]);
  const close = () => ref.current?.close();
  const hubName = web?.name ?? name;

  return (
    <dialog
      ref={ref}
      className="about-modal sheet-modal bm-modal ww-modal"
      aria-labelledby="ww-title"
      onClose={onClose}
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="about-body">
        <header className="about-head bm-head">
          <div className="bm-head-text">
            <h2 id="ww-title">
              <BubblesIcon size={18} /> {hubName}&apos;s wallet web
            </h2>
            <p className="faint small">
              {web && !web.kol
                ? "Every wallet its Multi-Wallet-Bundle would label, tied by what links each one"
                : "Every wallet labeled for this KOL, tied by what labeled each one"}
            </p>
          </div>
          <button type="button" className="ghost icon-btn" onClick={close} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </header>
        {error ? (
          <p className="error small">
            Couldn&apos;t load the web: {error}{" "}
            <button type="button" className="link" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </p>
        ) : !web ? (
          <div className="ww-loading" aria-busy="true">
            <LoadingNote slow="Still reading: a wallet with many coins takes longer." slowAfterMs={6000}>
              Gathering every labeled wallet and its ties…
            </LoadingNote>
          </div>
        ) : (
          <WebView web={web} hubName={hubName} onOpenWallet={close} />
        )}
      </div>
    </dialog>
  );
}

function WebView({
  web,
  hubName,
  onOpenWallet,
}: {
  web: SideWeb;
  hubName: string;
  onOpenWallet: () => void;
}) {
  const names = useWalletNames(useMemo(() => web.nodes.map((n) => n.wallet), [web]));
  const [hidden, setHidden] = useState<ReadonlySet<WebTie>>(new Set());
  const [picked, setPicked] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const layout = useMemo(() => layoutWeb(web), [web]);
  const edges = layout.edges.filter((e) => !hidden.has(e.type));
  const tieCount = (t: WebTie) => layout.edges.filter((e) => e.type === t).length;
  const active = hover ?? picked;
  const near = useMemo(() => {
    if (!active) return null;
    const s = new Set([active]);
    for (const e of edges) {
      if (e.from === active) s.add(e.to);
      if (e.to === active) s.add(e.from);
    }
    return s;
  }, [active, edges]);
  const pickedNode = layout.nodes.find((n) => n.wallet === picked) ?? null;
  const labeled = web.total - 1;
  const parts = web.kol
    ? [
        "1 main",
        web.counts.known && `${web.counts.known} Known Side${web.counts.known === 1 ? "" : "s"}`,
        web.counts.funded && `${web.counts.funded} KOL Funded`,
        web.counts.possible && `${web.counts.possible} Possible Side${web.counts.possible === 1 ? "" : "s"}`,
      ]
    : ["1 opened", labeled && `${labeled} would be labeled`];
  const funders = layout.nodes.filter((n) => n.role === "funder").length;
  const tiles = web.kol
    ? [
        { key: "known", label: "Known Sides", value: web.counts.known },
        { key: "funded", label: "KOL Funded", value: web.counts.funded },
        { key: "trades", label: "Possible Sides", value: web.counts.possible },
        { key: "transfers", label: "Moved coins", value: web.counts.transfers },
      ]
    : [
        {
          key: "trades",
          label: "Bought together",
          value: layout.nodes.filter((n) => n.role === "bundle" && !n.moverOnly).length,
        },
        { key: "transfers", label: "Moved coins", value: web.counts.transfers },
        { key: "funder", label: "Shared funders", value: funders },
      ];
  const showLabels = layout.nodes.length <= 28;

  return (
    <>
      <div className="ww-hero">
        <div className="ww-headline">
          <strong className="num">{web.total.toLocaleString("en-US")}</strong>
          <span>
            <span className="ww-headline-word">{web.total === 1 ? "wallet used" : "wallets used"}</span>
            <span className="faint small">{parts.filter(Boolean).join(" · ")}</span>
          </span>
          {/* The web as an image (user ask 2026-10-16), with the ties switched on as shown. */}
          {labeled > 0 && (
            <span className="ww-share">
              <ShareButton
                title={`${hubName}'s wallet web`}
                fileName={`trenchscanner-wallet-web-${
                  hubName
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/^-|-$/g, "") || web.hub.slice(0, 6)
                }`}
                caption={`${hubName}: ${walletCount(web.total)} used, mapped on TrenchScanner`}
                wide
                render={() => renderWalletWebCard(web, layout, names, hubName, hidden)}
              />
            </span>
          )}
        </div>
        <dl className="ww-tiles" style={{ "--ww-cols": tiles.length } as React.CSSProperties}>
          {tiles.map((t) => (
            <div key={t.key} className={`ww-tile tone-${t.key}${t.value === 0 ? " none" : ""}`}>
              <dt>
                <i className="ww-swatch" aria-hidden="true" />
                {t.label}
              </dt>
              <dd className="num">{t.value.toLocaleString("en-US")}</dd>
            </div>
          ))}
        </dl>
      </div>

      {labeled === 0 ? (
        <p className="muted small ww-empty">
          {web.kol
            ? `No wallet is labeled for ${hubName} yet: no Known Side, no wallet it funded, and no Possible Side.`
            : "No wallet would be labeled against it: none bought enough of the same coins, or moved enough coins with it."}
        </p>
      ) : (
        <>
          <div className="ww-legend" role="group" aria-label="Ties shown">
            {WEB_TIES.filter((t) => tieCount(t) > 0).map((t) => {
              const on = !hidden.has(t);
              return (
                <button
                  key={t}
                  type="button"
                  className={`ww-chip tone-${t}${on ? " on" : ""}`}
                  aria-pressed={on}
                  onClick={() =>
                    setHidden((h) => {
                      const next = new Set(h);
                      if (on) next.add(t);
                      else next.delete(t);
                      return next;
                    })
                  }
                >
                  <svg className="ww-chip-line" viewBox="0 0 22 8" width="22" height="8" aria-hidden="true">
                    <path d="M1 4h20" />
                  </svg>
                  {TIE_LABEL[t]}
                  <span className="ww-chip-n num">{tieCount(t)}</span>
                </button>
              );
            })}
          </div>
          <WebSvg
            layout={layout}
            edges={edges}
            names={names}
            hubName={hubName}
            near={near}
            active={active}
            picked={picked}
            showLabels={showLabels}
            onPick={(w) => setPicked((p) => (p === w ? null : w))}
            onHover={setHover}
          />
          {pickedNode ? (
            <WebDetail
              node={pickedNode}
              layout={layout}
              names={names}
              hubName={hubName}
              onOpenWallet={onOpenWallet}
              onPick={setPicked}
            />
          ) : (
            <p className="faint small ww-hint">
              Tap a bubble to see what ties it in. Each line is one link: gold a Known Side, cyan a funding
              (arrow from payer to paid), blue dots buying the same coins within minutes, violet coins moved
              between the two.
            </p>
          )}
          {web.truncated && (
            <p className="faint small">
              The strongest {layout.nodes.filter((n) => n.role !== "hub" && n.role !== "funder").length} of{" "}
              {walletCount(labeled)} are drawn; the headline counts every one.
            </p>
          )}
        </>
      )}
      <p className="faint small ww-note" role="note">
        Labels come from funding, timing and transfers on chain. A wallet here may still be a copy trader, a
        friend or a bot, not the same person. Not financial advice.
      </p>
    </>
  );
}

function WebSvg({
  layout,
  edges,
  names,
  hubName,
  near,
  active,
  picked,
  showLabels,
  onPick,
  onHover,
}: {
  layout: ReturnType<typeof layoutWeb>;
  edges: PlacedEdge[];
  names: WalletNames;
  hubName: string;
  near: Set<string> | null;
  active: string | null;
  picked: string | null;
  showLabels: boolean;
  onPick: (wallet: string) => void;
  onHover: (wallet: string | null) => void;
}) {
  const uid = useId().replace(/:/g, "");
  const { box } = layout;
  // Bigger bubbles first so the small ones draw on top and stay tappable; the hub last of all.
  const order = [...layout.nodes].sort((a, b) => (a.role === "hub" ? 1 : b.role === "hub" ? -1 : b.r - a.r));
  const lit = (e: PlacedEdge) => !active || e.from === active || e.to === active;
  return (
    <div className="bm-stage ww-stage">
      <svg
        className="bm-svg ww-svg"
        viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
        role="group"
        aria-label={`Wallet web of ${hubName}: ${layout.nodes.length} wallets`}
        onClick={(e) => {
          if (e.target === e.currentTarget && picked) onPick(picked);
        }}
      >
        <defs>
          {TONES.map((t) => (
            <radialGradient key={t} id={`${uid}-${t}`} cx="35%" cy="30%" r="75%">
              <stop offset="0%" style={{ stopColor: `color-mix(in srgb, var(--ww-${t}) 50%, white)` }} />
              <stop offset="100%" style={{ stopColor: `var(--ww-${t})` }} />
            </radialGradient>
          ))}
          <linearGradient id={`${uid}-hubfill`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" style={{ stopColor: "color-mix(in srgb, var(--ww-hub) 70%, white)" }} />
            <stop offset="100%" style={{ stopColor: "var(--ww-hub)" }} />
          </linearGradient>
          <linearGradient id={`${uid}-halo`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" style={{ stopColor: "var(--brand-a)" }} />
            <stop offset="100%" style={{ stopColor: "var(--brand-b)" }} />
          </linearGradient>
        </defs>
        {/* Faint rings round the hub, as on a radar. */}
        <g className="ww-rings" aria-hidden="true">
          {[96, 150, 210].map((r) => (
            <circle key={r} cx={0} cy={0} r={r} />
          ))}
        </g>
        <g className="ww-edges">
          {edges.map((e, i) => {
            const dim = !lit(e);
            const cls = `ww-edge tie-${e.type}${dim ? " dim" : ""}${active && !dim ? " on" : ""}`;
            if (e.type === "transfers")
              return (
                <g key={i} className={`bm-xfer ${cls}`}>
                  <path d={e.d} className="bm-xfer-glow" style={{ strokeWidth: e.width * 3.2 }} />
                  <path d={e.d} className="bm-xfer-line" style={{ strokeWidth: e.width }} />
                  <path
                    d={e.d}
                    className="bm-xfer-flow"
                    pathLength={100}
                    style={{ strokeWidth: e.width * 0.9 }}
                  />
                </g>
              );
            return (
              <g key={i} className={cls}>
                {e.type === "known" && (
                  <path d={e.d} className="ww-glow" style={{ strokeWidth: e.width * 3 }} />
                )}
                <path d={e.d} className="ww-line" style={{ strokeWidth: e.width }} />
                {e.type === "funded" && (
                  <polygon
                    className="ww-arrow"
                    points="-4.5,-4 5,0 -4.5,4"
                    transform={`translate(${e.mid.x.toFixed(1)} ${e.mid.y.toFixed(1)}) rotate(${e.mid.angle.toFixed(1)})`}
                  />
                )}
              </g>
            );
          })}
        </g>
        <g className="ww-nodes">
          {order.map((n) => {
            const tone = nodeTone(n);
            const dim = near !== null && !near.has(n.wallet);
            const label = nodeName(n, names, hubName);
            const inner = innerText(n, layout.edges);
            return (
              <g
                key={n.wallet}
                className={`bm-node ww-node role-${n.role}${dim ? " dim" : ""}${picked === n.wallet ? " on" : ""}`}
                role="button"
                tabIndex={0}
                aria-label={`${label}: ${ROLE_PILL[n.role]}`}
                aria-pressed={picked === n.wallet}
                onClick={() => onPick(n.wallet)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onPick(n.wallet);
                  }
                }}
                onPointerEnter={(e) => e.pointerType === "mouse" && onHover(n.wallet)}
                onPointerLeave={() => onHover(null)}
              >
                {n.role === "funder" ? (
                  <rect
                    x={n.x - n.r}
                    y={n.y - n.r}
                    width={n.r * 2}
                    height={n.r * 2}
                    rx={2.5}
                    transform={`rotate(45 ${n.x} ${n.y})`}
                    className="bm-bubble ww-funder"
                    fill={`url(#${uid}-funder)`}
                  />
                ) : (
                  <>
                    {n.role === "hub" && (
                      <circle
                        cx={n.x}
                        cy={n.y}
                        r={n.r + 6}
                        className="ww-hub-halo"
                        stroke={`url(#${uid}-halo)`}
                      />
                    )}
                    <circle
                      cx={n.x}
                      cy={n.y}
                      r={n.r}
                      fill={n.role === "hub" ? `url(#${uid}-hubfill)` : `url(#${uid}-${tone})`}
                      className="bm-bubble"
                      style={{ stroke: `var(--ww-${tone})` }}
                    />
                    <ellipse
                      cx={n.x - n.r * 0.32}
                      cy={n.y - n.r * 0.42}
                      rx={n.r * 0.42}
                      ry={n.r * 0.26}
                      transform={`rotate(-30 ${n.x - n.r * 0.32} ${n.y - n.r * 0.42})`}
                      className="bm-gloss"
                    />
                  </>
                )}
                {n.role === "hub" ? (
                  <text x={n.x} y={n.y + 1} className="ww-hub-initial">
                    {(hubName.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase()}
                  </text>
                ) : (
                  inner && (
                    <text
                      x={n.x}
                      y={n.y + 0.5}
                      className="ww-inner"
                      style={{ fontSize: Math.max(6.5, Math.min(9.5, n.r * 0.56)) }}
                    >
                      {inner}
                    </text>
                  )
                )}
              </g>
            );
          })}
        </g>
        {/* Names over every bubble, so none is hidden under a neighbour. */}
        <g className="ww-labels" aria-hidden="true">
          {order.map((n) => {
            const showLabel = showLabels || n.role === "hub" || (near?.has(n.wallet) ?? false);
            if (!showLabel) return null;
            const label = nodeName(n, names, hubName);
            const dim = near !== null && !near.has(n.wallet);
            return (
              <text
                key={n.wallet}
                x={n.x}
                y={n.y + n.r + (n.role === "hub" ? 18 : 11)}
                className={`ww-label${n.role === "hub" ? " hub" : ""}${dim ? " dim" : ""}`}
              >
                {label.length > 15 ? `${label.slice(0, 14)}…` : label}
              </text>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

function WebDetail({
  node,
  layout,
  names,
  hubName,
  onOpenWallet,
  onPick,
}: {
  node: PlacedNode;
  layout: ReturnType<typeof layoutWeb>;
  names: WalletNames;
  hubName: string;
  onOpenWallet: () => void;
  onPick: (wallet: string | null) => void;
}) {
  const [copied, setCopied] = useState(false);
  const byWallet = new Map(layout.nodes.map((n) => [n.wallet, n]));
  const ties = layout.edges.filter((e) => e.from === node.wallet || e.to === node.wallet);
  const name = nodeName(node, names, hubName);
  return (
    <section className={`ww-detail tone-${nodeTone(node)}`} aria-live="polite">
      <header>
        <i className="ww-swatch" aria-hidden="true" />
        <strong>{name}</strong>
        <span className="pill ww-role">{ROLE_PILL[node.role]}</span>
        <span className="ww-detail-actions">
          <button
            type="button"
            className="ghost small-btn"
            onClick={() => {
              void navigator.clipboard?.writeText(node.wallet).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1400);
              });
            }}
            title={node.wallet}
          >
            {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />} {shortAddress(node.wallet)}
          </button>
          <button
            type="button"
            className="ghost small-btn"
            onClick={() => {
              onOpenWallet();
              openWallet(node.wallet);
            }}
          >
            <WalletIcon size={13} /> Open wallet
          </button>
        </span>
      </header>
      {ties.length > 0 && (
        <ul className="ww-ties">
          {ties.map((e, i) => {
            const other = byWallet.get(e.from === node.wallet ? e.to : e.from);
            const [before, after] = tieText(e, node.wallet);
            return (
              <li key={i} className={`tone-${e.type}`}>
                <i className="ww-swatch" aria-hidden="true" />
                <span>
                  {before}
                  {other ? (
                    <button type="button" className="link" onClick={() => onPick(other.wallet)}>
                      {nodeName(other, names, hubName)}
                    </button>
                  ) : (
                    "another wallet"
                  )}
                  {after}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {node.role === "funder" && (
        <p className="faint small">
          Paid for the first SOL of {walletCount(node.funds ?? 0)} in this web. Not labeled itself.
        </p>
      )}
    </section>
  );
}
