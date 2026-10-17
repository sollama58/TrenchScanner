import { ago, pct, signedPct, usd } from "../format";
import { openSage } from "../sage";
import { openWallet } from "../walletModal";
import { useWalletNames } from "../walletNames";
import { ExternalIcon, LinkIcon, SendIcon, WalletIcon, XLogoIcon } from "./Icons";
import type { SageRead } from "./SageView";
import { WalletText } from "./WalletText";

/** Mirrors apps/api/src/tokenProfile.ts DevLaunchRecord. */
export interface DevLaunchRecord {
  score: number;
  launches: number;
  inBand: number;
  graded: number;
  wins: number;
  stops: number;
}

/** Mirrors apps/api/src/tokenProfile.ts TokenProfile. */
export interface TokenProfile {
  dev: {
    wallet: string;
    risk: number | null;
    launch: DevLaunchRecord | null;
    family: (DevLaunchRecord & { creators: number }) | null;
    coins: {
      mint: string;
      symbol: string | null;
      at: string;
      outcome: "win" | "stop" | "fizzle" | null;
      peakPct: number | null;
      reachedBand: boolean | null;
    }[];
  } | null;
  socials: { x: string | null; telegram: string | null; website: string | null; unread: boolean };
  flow: {
    at: string;
    buys5m: number | null;
    sells5m: number | null;
    buys1h: number | null;
    sells1h: number | null;
    volume5mUsd: number | null;
    volume1hUsd: number | null;
    priceChange5mPct: number | null;
    priceChange1hPct: number | null;
    buyers: { count: number; through: string } | null;
  } | null;
}

const OUTCOME = {
  win: { text: "2x", tone: "good" },
  stop: { text: "Stopped", tone: "bad" },
  fizzle: { text: "No 2x", tone: "" },
} as const;

/**
 * The coin's order flow (user ask 2026-10-16): buys against sells over 5 minutes and the hour, as
 * the newest scan counted them, with the volume and the price move beside each.
 */
export function FlowCard({ flow, now }: { flow: TokenProfile["flow"]; now: number }) {
  if (!flow) return null;
  const windows = [
    {
      label: "5 min",
      buys: flow.buys5m,
      sells: flow.sells5m,
      vol: flow.volume5mUsd,
      move: flow.priceChange5mPct,
    },
    {
      label: "1 hour",
      buys: flow.buys1h,
      sells: flow.sells1h,
      vol: flow.volume1hUsd,
      move: flow.priceChange1hPct,
    },
  ];
  return (
    <section className="sage-card tm-flow" aria-label="Order flow">
      <h4>
        Order flow
        <span className="tm-h4-meta small muted">Scan {ago(flow.at, now)}</span>
      </h4>
      <div className="tm-flow-rows">
        {windows.map((w) => {
          const total = (w.buys ?? 0) + (w.sells ?? 0);
          const buyShare = w.buys !== null && w.sells !== null && total > 0 ? (w.buys / total) * 100 : null;
          return (
            <div key={w.label} className="tm-flow-row">
              <span className="tm-flow-label small muted">{w.label}</span>
              <span className="tm-flow-bar" aria-hidden="true">
                {buyShare !== null ? (
                  <>
                    <span className="buy" style={{ width: `${buyShare}%` }} />
                    <span className="sell" style={{ width: `${100 - buyShare}%` }} />
                  </>
                ) : (
                  <span className="none" />
                )}
              </span>
              <span className="tm-flow-counts num small">
                {buyShare === null ? (
                  <span className="muted">Not read</span>
                ) : (
                  <>
                    <span className="up">{w.buys} buys</span>
                    <span className="faint"> / </span>
                    <span className="down">{w.sells} sells</span>
                    <span className="muted"> · {pct(buyShare)} buys</span>
                  </>
                )}
              </span>
              <span className="tm-flow-meta num small muted">
                Vol {usd(w.vol)}
                {w.move !== null && <span className={w.move >= 0 ? "up" : "down"}> {signedPct(w.move)}</span>}
              </span>
            </div>
          );
        })}
      </div>
      {flow.buyers && (
        <p className="small muted tm-flow-note">
          {flow.buyers.count} distinct wallet{flow.buyers.count === 1 ? "" : "s"} bought it, from its trade
          tape up to{" "}
          {new Date(flow.buyers.through).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.
        </p>
      )}
    </section>
  );
}

/** The tag tone for a 0-100 score where higher is riskier (core's RISKY_* lines are at 70). */
function riskTone(score: number): string {
  return score >= 70 ? "tone-bad" : score >= 40 ? "tone-warn" : "";
}

/** "3 of 5 graded doubled", or nothing when none was graded. */
function gradedText(r: DevLaunchRecord): string {
  return r.graded > 0 ? `, ${r.wins} of ${r.graded} graded doubled` : "";
}

/**
 * Who launched the coin and what else they launched (user ask 2026-10-16): the creator wallet, its
 * two scores - trading risk (how the wallet trades) and launch risk (how its launches went, user ask
 * 2026-10-17) - its funder's other devs, and its other coins, with how each did.
 */
export function DevCard({ dev }: { dev: TokenProfile["dev"] | undefined }) {
  const names = useWalletNames(dev ? [dev.wallet] : []);
  if (dev === undefined) return null;
  const wins = dev?.coins.filter((c) => c.outcome === "win").length ?? 0;
  const graded = dev?.coins.filter((c) => c.outcome !== null).length ?? 0;
  return (
    <section className="sage-card tm-dev">
      <h4>
        <WalletIcon size={14} /> Dev
        {dev && dev.launch && (
          <span
            className={`sage-tag ${riskTone(dev.launch.score)}`}
            title="Launch risk, 0-100: how this dev's coins in the last 14 days went against every launch (reached the band, doubled, stopped), and how many it launched"
          >
            Launch risk {Math.round(dev.launch.score)}
          </span>
        )}
        {dev && dev.risk !== null && (
          <span
            className={`sage-tag ${riskTone(dev.risk)}`}
            title="Trading risk, 0-100: how the dev wallet trades, from selling into earlier calls' stops"
          >
            Trading risk {Math.round(dev.risk)}
          </span>
        )}
      </h4>
      {!dev ? (
        <p className="small muted">The creator wallet isn&apos;t known for this coin yet.</p>
      ) : (
        <>
          <p className="tm-dev-who">
            <button
              type="button"
              className="tm-wallet tm-wallet-btn"
              onClick={() => openWallet(dev.wallet)}
              title="Open the dev wallet's details"
            >
              <WalletText wallet={dev.wallet} names={names} />
            </button>
            <a
              className="tm-link small"
              href={`https://solscan.io/account/${dev.wallet}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Solscan <ExternalIcon size={10} />
            </a>
          </p>
          {dev.launch && (
            <p className="small muted">
              {dev.launch.launches} coin{dev.launch.launches === 1 ? "" : "s"} launched in the last 14 days,{" "}
              {dev.launch.inBand} reached the band{gradedText(dev.launch)}.
            </p>
          )}
          {dev.family && dev.family.creators > 1 && (
            <p className="small muted">
              The wallet that funded it also funded {dev.family.creators - 1} other dev
              {dev.family.creators === 2 ? "" : "s"}; together they launched {dev.family.launches} coins,{" "}
              {dev.family.inBand} reached the band{gradedText(dev.family)}.{" "}
              <span className={`sage-tag ${riskTone(dev.family.score)}`}>
                Funder {Math.round(dev.family.score)}
              </span>
            </p>
          )}
          {dev.coins.length === 0 ? (
            <p className="small muted">No other coins of this dev in the scanner&apos;s records.</p>
          ) : (
            <>
              <p className="small muted">
                {dev.coins.length} other coin{dev.coins.length === 1 ? "" : "s"} it launched
                {graded > 0 && (
                  <>
                    , <strong className={wins > 0 ? "up" : ""}>{wins}</strong> of {graded} doubled
                  </>
                )}
                .
              </p>
              <ul className="tm-dev-coins">
                {dev.coins.map((c) => (
                  <li key={c.mint}>
                    <button type="button" className="tm-link" onClick={() => openSage(c.mint)}>
                      {c.symbol ? `$${c.symbol}` : c.mint.slice(0, 6)}
                    </button>
                    <span className="faint small">{ago(c.at)}</span>
                    {!c.outcome && c.reachedBand === false && Date.now() - Date.parse(c.at) > 3_600_000 && (
                      <span className="sage-tag" title="Never reached the alert band">
                        Died early
                      </span>
                    )}
                    {c.outcome && (
                      <span
                        className={`sage-tag ${OUTCOME[c.outcome].tone ? `tone-${OUTCOME[c.outcome].tone}` : ""}`}
                      >
                        {OUTCOME[c.outcome].text}
                      </span>
                    )}
                    {c.peakPct !== null && c.peakPct > 0 && (
                      <span className="num small muted">peak {signedPct(c.peakPct)}</span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}

function followersText(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function ageText(s: number): string {
  const d = s / 86_400;
  if (d >= 365) return `${(d / 365).toFixed(1)} years`;
  if (d >= 1) return `${Math.round(d)} day${Math.round(d) === 1 ? "" : "s"}`;
  const h = s / 3600;
  return h >= 1 ? `${Math.round(h)} hour${Math.round(h) === 1 ? "" : "s"}` : "under an hour";
}

/** Strips the scheme for display: "x.com/coin". */
function shown(url: string): string {
  return url.replace(/^https:\/\//, "").replace(/\/$/, "");
}

/**
 * The coin's socials (user ask 2026-10-16): its X, Telegram and website as links, and what
 * TokenSage read of the X account (its age at launch, followers, whether it was made for the coin).
 */
export function SocialsCard({
  socials,
  x,
}: {
  socials: TokenProfile["socials"] | undefined;
  x: SageRead["x"] | null | undefined;
}) {
  if (!socials) return null;
  const xUrl = socials.x ?? (x?.url && x.url.startsWith("https://") ? x.url : null);
  const rows = [
    { key: "x", label: "X", icon: <XLogoIcon size={13} />, url: xUrl },
    { key: "tg", label: "Telegram", icon: <SendIcon size={13} />, url: socials.telegram },
    { key: "web", label: "Website", icon: <LinkIcon size={13} />, url: socials.website },
  ];
  const found = rows.filter((r) => r.url).length;
  const facts: string[] = [];
  if (x?.author?.handle) facts.push(`@${x.author.handle}`);
  if (x?.author?.followers != null) facts.push(`${followersText(x.author.followers)} followers`);
  if (x?.accountAgeS != null) facts.push(`account ${ageText(x.accountAgeS)} old at launch`);
  if (x?.madeForCoin) facts.push("made for this coin");
  return (
    <section className="sage-card tm-socials">
      <h4>
        Socials
        <span className="sage-tag">{found}/3</span>
      </h4>
      <ul className="tm-social-list">
        {rows.map((r) => (
          <li key={r.key} className={r.url ? "" : "missing"}>
            <span className="tm-social-icon" aria-hidden="true">
              {r.icon}
            </span>
            <span className="tm-social-label">{r.label}</span>
            {r.url ? (
              <a className="tm-social-link" href={r.url} target="_blank" rel="noopener noreferrer nofollow">
                <span>{shown(r.url)}</span>
                <ExternalIcon size={10} />
              </a>
            ) : (
              <span className="faint small">{socials.unread ? "Not read yet" : "None linked"}</span>
            )}
          </li>
        ))}
      </ul>
      {facts.length > 0 && <p className="small muted tm-social-facts">X account: {facts.join(" · ")}.</p>}
      {found > 0 && (
        <p className="faint small">Links come from the launcher. Check them before you trust them.</p>
      )}
    </section>
  );
}
