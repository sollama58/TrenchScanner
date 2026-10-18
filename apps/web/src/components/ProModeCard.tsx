import { useEffect } from "react";
import { recheckMe, useMe } from "../me";
import { graceLeftText, useProState } from "../proTrade";
import { useNow } from "../hooks";
import type { WalletBalance } from "../walletBalance";
import { CrownIcon, FlameIcon } from "./Icons";

/** What Pro Mode unlocks, in the order a trader meets it. Shared with the About tour. */
export const PRO_MODE_PERKS: { title: string; text: string }[] = [
  {
    title: "Trade in the coin window",
    text: "Buy and sell any coin from its window, with no TrenchScanner fee.",
  },
  {
    title: "Quick buy",
    text: "One-tap buy buttons on the feed's cards, with your own amounts in Settings › Trading.",
  },
  {
    title: "TRADES panel",
    text: "Your last ten trades and the past day's figures, from a handle on every tab (desktop).",
  },
  { title: "Portfolio tab", text: "Everything you hold and have traded, in one place." },
  {
    title: "Bigger chart",
    text: "A larger chart in the coin window, with your buys and sells marked on it.",
  },
  {
    title: "Wallet labels",
    text: "Label up to 25 wallets, shown with the KOLs or as your own on bubble maps.",
  },
];

/** "1.24M": a whole-token figure, short. */
function compactTokens(raw: bigint, decimals: number): string {
  const tokens = Number(raw / 10n ** BigInt(decimals));
  return tokens.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
}

/**
 * Settings' Pro Mode card (user ask 2026-10-18): whether the wallet has Pro Mode and why, the
 * countdown while it qualifies, what it takes to get in (the 250th holder's bag, from the holder
 * scan), and what Pro Mode unlocks. Reads the same GET /subscription/balance as the wallet tiles.
 */
export function ProModeCard({ funds, onBuy }: { funds: WalletBalance; onBuy: (() => void) | null }) {
  const me = useMe();
  const pro = useProState();
  const now = useNow(30_000);
  const { balance } = funds;
  const holder = balance?.holder ?? null;
  const source = pro?.pro ? (me?.proMode?.source ?? null) : null;
  const qualifiesAt = holder?.qualifiesAt ? Date.parse(holder.qualifiesAt) : NaN;
  const qualifying = !pro?.pro && Number.isFinite(qualifiesAt);
  const pending = qualifying && qualifiesAt > now;
  // The hour is up: the next scan (every 5 minutes) switches Pro Mode on. Read the rank and the
  // session again each minute until it shows, so it does without a reload.
  const due = qualifying && !pending;
  const { reload } = funds;
  useEffect(() => {
    if (!due) return;
    const check = () => {
      reload();
      recheckMe();
    };
    check();
    const timer = window.setInterval(check, 60_000);
    return () => window.clearInterval(timer);
  }, [due, reload]);
  const cutoff = holder?.cutoffRaw && balance ? BigInt(holder.cutoffRaw) : null;
  const held = balance ? BigInt(balance.totalRaw) : null;
  const short =
    cutoff !== null && held !== null && holder?.rank == null && cutoff >= held ? cutoff - held : null;

  const status = pro?.pro
    ? pro.graceEndsAt !== null
      ? {
          tone: "warn",
          big: "Ending soon",
          line: `Pro Mode ends in ${graceLeftText(pro.graceEndsAt, now)} unless ${
            pro.graceUnconfirmed ? "your place is confirmed" : "you're back in the top 250"
          }.`,
        }
      : {
          tone: "on",
          big: "Active",
          line:
            source === "admin"
              ? "Admin wallet: always on."
              : source === "grant"
                ? "Granted by an admin."
                : `You're #${me?.proMode?.rank ?? holder?.rank ?? "?"} of the top 250 holders.`,
        }
    : pending
      ? {
          tone: "pending",
          big: `In ${Math.max(1, Math.ceil((qualifiesAt - now) / 60_000))} min`,
          line: `Qualifying: you're #${holder?.rank} of the top 250. Stay in and Pro Mode starts on its own.`,
        }
      : due
        ? {
            tone: "pending",
            big: "Any minute",
            line: `You've held your place for the hour (#${holder?.rank}). Pro Mode switches on at the next scan.`,
          }
        : balance?.proOpen === false
          ? { tone: "off", big: "Not open yet", line: "Pro Mode isn't open to holders yet." }
          : { tone: "off", big: "Not yet", line: "Be one of the top 250 $ASDFASDFA holders to get it." };

  return (
    <section className={`pro-card ${status.tone}`} aria-label="Pro Mode">
      <div className="pro-card-head">
        <span className="sub-kicker">
          <CrownIcon size={13} /> Pro Mode
        </span>
        <strong className="pro-card-big num">{status.big}</strong>
        <span className="sub-line">{status.line}</span>
      </div>
      {!(pro?.pro && (source === "admin" || source === "grant")) && balance?.proOpen !== false && (
        <div className="pro-card-how">
          <h4>How to get it</h4>
          <p className="small">
            Hold enough $ASDFASDFA to be one of the 250 largest wallets. We check every 5 minutes, and it
            switches on by itself. If you drop out, you keep it for 24 hours.
          </p>
          {cutoff !== null && balance && (
            <p className="small pro-card-cutoff">
              Right now #250 holds about{" "}
              <strong className="num">{compactTokens(cutoff, balance.decimals)} $ASDFASDFA</strong>
              {short !== null && (
                <>
                  , so you need about{" "}
                  <strong className="num">{compactTokens(short, balance.decimals)}</strong> more
                </>
              )}
              .
            </p>
          )}
          {!pro?.pro && onBuy && (
            <button type="button" className="ghost pro-card-buy" onClick={onBuy}>
              <FlameIcon size={14} /> Buy $ASDFASDFA
            </button>
          )}
        </div>
      )}
      <div className="pro-card-perks">
        <h4>{pro?.pro ? "What you have" : "What it unlocks"}</h4>
        <ul>
          {PRO_MODE_PERKS.map((p) => (
            <li key={p.title}>
              <b>{p.title}</b>
              <span>{p.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
