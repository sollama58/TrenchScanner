import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type LighthouseSignals } from "../api";
import { HitRates, narratives, seriesClassFor } from "../components/MarketLighthouse";
import { narrativeBaseline } from "../lighthouseMetrics";
import { LogoMark, SageIcon, SendIcon } from "../components/Icons";
import { ShareDialog } from "./ShareDialog";
import type { ShareCardKind } from "./shareCards";
import {
  compact,
  hitRate,
  logoKinds,
  named,
  prettyLabel,
  share,
  type ShowcaseCount,
  type TokenSageShowcase,
} from "./showcase";

/**
 * /tokensage: TokenSage as a product, and what it has read so far. Its own page (tokensage/
 * index.html), not a dashboard tab, and not linked from the dashboard yet. Every figure is a count
 * over many coins from GET /guest/tokensage; no coin, mint or wallet is ever named.
 */

const REFRESH_MS = 5 * 60_000;

/** "Which narratives pay" reads over a day, a week or a month, as Signals at a glance does. */
export const PAY_WINDOWS = [1, 7, 30] as const;
export type PayDays = (typeof PAY_WINDOWS)[number];
const PAY_LABEL: Record<PayDays, string> = { 1: "24h", 7: "7d", 30: "1mo" };
export const PAY_SPAN: Record<PayDays, string> = { 1: "24 hours", 7: "7 days", 30: "30 days" };

/**
 * How calls did by narrative over a window, for "Which narratives pay": the Lighthouse's signals
 * answer, which carries the per-narrative returns the rollup the rest of the page sums does not.
 */
export const payPath = (days: PayDays) => `/guest/lighthouse/signals?days=${days}`;

function useShowcase() {
  const [data, setData] = useState<TokenSageShowcase | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      void api<TokenSageShowcase>("/guest/tokensage").then(
        (d) => {
          if (!live) return;
          setData(d);
          setError(null);
        },
        (err: unknown) => live && setError(err instanceof Error ? err.message : "Couldn't load"),
      );
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return { data, error };
}

/**
 * "Which narratives pay" for the picked window. Optional: without it that section waits, and the
 * rest of the page is unaffected. The last answer stays on screen while another window loads.
 */
function usePay(days: PayDays) {
  const [pay, setPay] = useState<LighthouseSignals | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      void api<LighthouseSignals>(payPath(days)).then(
        (l) => live && setPay(l),
        () => undefined,
      );
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [days]);
  return pay;
}

/** Opens a section's share image; null until the numbers have loaded. */
const ShareContext = createContext<((kind: ShareCardKind) => void) | null>(null);

/** The button that opens a section's branded share image. */
function ShareButton({ kind, label = "Share" }: { kind: ShareCardKind; label?: string }) {
  const open = useContext(ShareContext);
  if (!open) return null;
  return (
    <button type="button" className="tsg-share" onClick={() => open(kind)}>
      <SendIcon size={14} />
      {label}
    </button>
  );
}

export function TokenSagePage() {
  const { data, error } = useShowcase();
  const [payDays, setPayDays] = useState<PayDays>(7);
  const pay = usePay(payDays);
  const [sharing, setSharing] = useState<ShareCardKind | null>(null);
  return (
    <ShareContext.Provider value={data ? setSharing : null}>
      <div className="tsg">
        <div className="tsg-glow" aria-hidden />
        <header className="tsg-top">
          <a href="/" className="tsg-brand">
            <LogoMark size={26} />
            <span>TrenchScanner</span>
          </a>
          <span className="tsg-pill">Preview</span>
        </header>
        <main className="tsg-main">
          <Hero data={data} />
          {error && !data ? (
            <p className="tsg-error" role="alert">
              The numbers didn't load ({error}). They will try again in a few minutes.
            </p>
          ) : null}
          <Tiles data={data} />
          <Anatomy data={data} />
          {data ? (
            <Sections data={data} pay={pay} payDays={payDays} onPayDays={setPayDays} />
          ) : (
            <LoadingSections />
          )}
        </main>
        <Footer data={data} />
        {sharing && data ? (
          <ShareDialog key={sharing} kind={sharing} data={data} pay={pay} onClose={() => setSharing(null)} />
        ) : null}
      </div>
    </ShareContext.Provider>
  );
}

// ---------- Hero ----------

function Hero({ data }: { data: TokenSageShowcase | null }) {
  const since = data?.since
    ? new Date(data.since).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })
    : null;
  return (
    <section className="tsg-hero">
      <div className="tsg-hero-copy">
        <span className="tsg-eyebrow">
          <SageIcon size={16} /> TokenSage
        </span>
        <h1>
          Every new coin, <span className="tsg-grad">read and understood</span> in seconds.
        </h1>
        <p className="tsg-lede">
          TokenSage looks at a fresh Solana launch the way a seasoned trader would: its name and logo, the X
          account behind it, the news, and every coin that came before it. Then it says what the coin is
          about, whether it is a copy, and what to be wary of. TrenchScanner's models weigh it when they make
          a call.
        </p>
        <div className="tsg-hero-figure">
          <span className="tsg-hero-num">{data ? compact(data.totals.reads) : "…"}</span>
          <span className="tsg-hero-cap">coins read{since ? ` since ${since}` : ""}</span>
          <ShareButton kind="headline" label="Share the numbers" />
        </div>
      </div>
      <SageArt />
    </section>
  );
}

/** The hero picture: TokenSage's eye, with a few of the things a read finds orbiting it. */
function SageArt() {
  const chips = [
    { text: "Animal › Dog", x: 8, y: 22 },
    { text: "Late copy · #4 of 9", x: 58, y: 8 },
    { text: "X post: about this coin", x: 62, y: 78 },
    { text: "Fee → holder rewards", x: 2, y: 70 },
  ];
  return (
    <div className="tsg-art" aria-hidden>
      <svg viewBox="0 0 400 400" className="tsg-art-svg">
        <defs>
          <linearGradient id="tsg-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--brand-a)" />
            <stop offset="1" stopColor="var(--brand-b)" />
          </linearGradient>
          <radialGradient id="tsg-iris" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="#fff" stopOpacity="0.95" />
            <stop offset="0.35" stopColor="var(--brand-b)" />
            <stop offset="1" stopColor="var(--brand-a)" />
          </radialGradient>
        </defs>
        <g className="tsg-orbits" fill="none" stroke="url(#tsg-g)">
          <circle cx="200" cy="200" r="178" strokeOpacity="0.18" strokeWidth="1" />
          <circle cx="200" cy="200" r="140" strokeOpacity="0.28" strokeWidth="1" strokeDasharray="2 7" />
          <circle cx="200" cy="200" r="104" strokeOpacity="0.4" strokeWidth="1.5" />
        </g>
        <g className="tsg-sweep">
          <path d="M200 200 L200 22 A178 178 0 0 1 340 90 Z" fill="url(#tsg-g)" fillOpacity="0.1" />
        </g>
        <path
          d="M90 200 C 130 136, 270 136, 310 200 C 270 264, 130 264, 90 200 Z"
          fill="var(--surface-solid)"
          stroke="url(#tsg-g)"
          strokeWidth="5"
          strokeLinejoin="round"
        />
        <circle cx="200" cy="200" r="38" fill="url(#tsg-iris)" />
        <circle cx="200" cy="200" r="14" fill="var(--page)" />
        <circle cx="190" cy="190" r="5" fill="#fff" fillOpacity="0.9" />
        <path d="M300 96 v24 M288 108 h24" stroke="url(#tsg-g)" strokeWidth="5" strokeLinecap="round" />
        <circle className="tsg-blip" cx="322" cy="150" r="5" fill="var(--brand-b)" />
        <circle className="tsg-blip d2" cx="96" cy="276" r="4" fill="var(--brand-a)" />
      </svg>
      {chips.map((c) => (
        <span key={c.text} className="tsg-chip" style={{ left: `${c.x}%`, top: `${c.y}%` }}>
          {c.text}
        </span>
      ))}
    </div>
  );
}

// ---------- Headline tiles ----------

function Tiles({ data }: { data: TokenSageShowcase | null }) {
  const t = data?.totals;
  const tiles: { label: string; value: string; note: string }[] = [
    {
      label: "Read in the last 24 hours",
      value: data ? compact(data.last24h.reads) : "…",
      note: data ? `${compact(data.last24h.deep)} of them in depth` : "",
    },
    {
      label: "Deep reads",
      value: t ? compact(t.deep) : "…",
      note: t ? `${share(t.deep, t.described)} of coins described` : "",
    },
    {
      label: "Copies of a recent coin",
      value: t ? share(t.copiesRecent, t.copiesAnswered) : "…",
      note: t ? `of ${compact(t.copiesAnswered)} coins checked for a lineage` : "",
    },
    {
      label: "Model calls with a read",
      value: t ? share(t.alertsDescribed, t.alerts) : "…",
      note: t ? `${compact(t.alertsDescribed)} of ${compact(t.alerts)} calls` : "",
    },
  ];
  return (
    <section className="tsg-tiles" aria-label="Headline numbers">
      {tiles.map((tile) => (
        <div className="tsg-tile" key={tile.label}>
          <span className="tsg-tile-label">{tile.label}</span>
          <span className="tsg-tile-value">{tile.value}</span>
          <span className="tsg-tile-note">{tile.note}</span>
        </div>
      ))}
    </section>
  );
}

// ---------- What a read looks at, and what it says ----------

const INPUTS = [
  { title: "Name & ticker", text: "What the words point at, in any language or slang" },
  { title: "Description", text: "The pitch the launcher wrote" },
  { title: "Logo", text: "What the picture shows, and whether it was used before" },
  { title: "X link", text: "The post or account it links, and who is behind it" },
  { title: "News & trends", text: "Wikipedia and news spikes around the name" },
  { title: "Earlier coins", text: "Every launch that shared its name, ticker or logo" },
];
const OUTPUTS = [
  { title: "Theme", text: "Animal, celebrity, AI agent, news… and how sure it is" },
  { title: "Referent", text: "The real thing the coin is about" },
  { title: "Lineage", text: "Original or copy, and its place in the wave" },
  { title: "X check", text: "Does the link match the coin? How credible is the account?" },
  { title: "Creator fee", text: "Where pump.fun's fee goes: the dev, holders, a charity" },
  { title: "Flags", text: "Copycat, reused X link, spoofed account, mismatches" },
];

function Anatomy({ data }: { data: TokenSageShowcase | null }) {
  const depth = data?.anatomy.depth ?? [];
  const full = depth.find((d) => d.label === "full")?.count ?? 0;
  const basic = depth.find((d) => d.label === "basic")?.count ?? 0;
  return (
    <Section
      id="anatomy"
      kicker="How it works"
      title="What a read looks at, and what it says"
      lede="Six kinds of evidence go in. One structured answer comes out, the same shape every time, so a model can learn from it."
    >
      <div className="tsg-flow">
        <ol className="tsg-flow-col">
          {INPUTS.map((i) => (
            <li key={i.title} className="tsg-flow-item in">
              <strong>{i.title}</strong>
              <span>{i.text}</span>
            </li>
          ))}
        </ol>
        <div className="tsg-flow-core" aria-hidden>
          <svg viewBox="0 0 120 240" className="tsg-flow-lines" preserveAspectRatio="none">
            {[20, 60, 100, 140, 180, 220].map((y) => (
              <path key={`l${y}`} d={`M0 ${y} C 40 ${y}, 40 120, 60 120`} />
            ))}
            {[20, 60, 100, 140, 180, 220].map((y) => (
              <path key={`r${y}`} d={`M60 120 C 80 120, 80 ${y}, 120 ${y}`} />
            ))}
          </svg>
          <div className="tsg-flow-node">
            <SageIcon size={30} />
            <span>TokenSage</span>
          </div>
        </div>
        <ol className="tsg-flow-col">
          {OUTPUTS.map((o) => (
            <li key={o.title} className="tsg-flow-item out">
              <strong>{o.title}</strong>
              <span>{o.text}</span>
            </li>
          ))}
        </ol>
      </div>
      <div className="tsg-depths">
        <div className="tsg-depth">
          <span className="tsg-depth-tag quick">Quick read</span>
          <p>
            The moment a coin launches: theme, referent and copycat check from its name, ticker, description
            and the coins before it. Fast enough for the first minute of a coin's life.
          </p>
          {data ? <span className="tsg-depth-n">{compact(basic)} coins kept at this depth</span> : null}
        </div>
        <div className="tsg-depth">
          <span className="tsg-depth-tag deep">Deep read</span>
          <p>
            For every coin a model looks at closely: it also opens the X link, checks the account's age and
            credibility, reads the logo, matches the news and traces the creator fee.
          </p>
          {data ? <span className="tsg-depth-n">{compact(full)} coins kept at this depth</span> : null}
        </div>
      </div>
    </Section>
  );
}

// ---------- The data sections ----------

function Sections({
  data,
  pay,
  payDays,
  onPayDays,
}: {
  data: TokenSageShowcase;
  pay: LighthouseSignals | null;
  payDays: PayDays;
  onPayDays: (d: PayDays) => void;
}) {
  const t = data.totals;
  const themes = named(data.labels.category);
  const subThemes = named(data.labels.subcategory).slice(0, 8);
  const flags = named(data.labels.flag);
  const copyRows = data.labels.copy;
  return (
    <>
      <Section
        id="themes"
        share="themes"
        kicker="What the trenches are about"
        title="Themes"
        lede="The theme TokenSage is surest of, one per coin, across every coin it has described."
      >
        <div className="tsg-grid2">
          <div className="tsg-card">
            <h3>Top themes</h3>
            <RankBars
              rows={themes.map((l) => ({
                label: prettyLabel(l.label),
                value: l.count,
                display: compact(l.count),
                note: share(l.count, t.described),
              }))}
            />
          </div>
          <div className="tsg-card">
            <h3>Most-read sub-themes</h3>
            <p className="tsg-card-sub">A coin can carry several.</p>
            <ul className="tsg-chips">
              {subThemes.map((s, i) => (
                <li key={s.label} className={i < 3 ? "is-top" : undefined}>
                  <span>{prettyLabel(s.label)}</span>
                  <b className="num">{compact(s.count)}</b>
                </li>
              ))}
              {subThemes.length === 0 ? <li className="tsg-empty">None yet</li> : null}
            </ul>
          </div>
        </div>
      </Section>

      <Section
        id="lineage"
        share="lineage"
        kicker="Originals and copies"
        title="Most new coins are a copy of something"
        lede="TokenSage lines each coin up against every launch that shared its name, ticker or logo, and says where it falls in the wave."
      >
        <div className="tsg-card">
          <h3>Lineage of the coins kept</h3>
          <SegmentBar
            rows={data.anatomy.lineage}
            order={["original", "early_copy", "copy", "late_copy", "reference"]}
          />
        </div>
        {copyRows.length > 0 ? (
          <div className="tsg-compare">
            {copyRows
              .filter((r) => r.label !== "other")
              .map((r) => {
                const rate = hitRate(r);
                return (
                  <div className="tsg-compare-item" key={r.label}>
                    <span className="tsg-tile-label">
                      {r.label === "original" ? "Originals" : "Copies of a recent coin"}
                    </span>
                    <span className="tsg-tile-value">{compact(r.count)}</span>
                    <span className="tsg-tile-note">
                      {rate === null
                        ? `model calls on them: ${r.graded} graded, too few to rate`
                        : `${rate.toFixed(0)}% of ${compact(r.graded)} graded model calls doubled`}
                    </span>
                  </div>
                );
              })}
          </div>
        ) : null}
      </Section>

      <Section
        id="flags"
        share="flags"
        kicker="What to be wary of"
        title="Flags raised"
        lede="Warnings TokenSage attaches to a coin. One coin can carry several."
      >
        <div className="tsg-card">
          <RankBars
            rows={flags.map((l) => ({
              label: prettyLabel(l.label),
              value: l.count,
              display: compact(l.count),
              note: share(l.count, t.described),
            }))}
          />
        </div>
      </Section>

      <Section
        id="logos-fees"
        kicker="Pictures and money"
        title="Logos and creator fees"
        lede="What the logos show, and where pump.fun's creator fee is set to go."
      >
        <div className="tsg-grid2">
          <div className="tsg-card">
            <div className="tsg-card-head">
              <h3>What the logo shows</h3>
              <ShareButton kind="logos" />
            </div>
            <RankBars
              rows={logoKinds(data.anatomy.logo).map((r) => ({
                label: prettyLabel(r.label),
                value: r.count,
                display: compact(r.count),
              }))}
            />
          </div>
          <div className="tsg-card">
            <div className="tsg-card-head">
              <h3>Where the creator fee goes</h3>
              <ShareButton kind="fees" />
            </div>
            <RankBars
              rows={named(data.anatomy.fee).map((r) => ({
                label: prettyLabel(r.label),
                value: r.count,
                display: compact(r.count),
              }))}
            />
          </div>
        </div>
      </Section>

      <Section
        id="models"
        kicker="Into the call"
        title="How the read reaches a buy call"
        lede="The read is an input to TrenchScanner's models, the Narrative model decides on the deep read, and filters and Telegram alerts can screen on it."
      >
        <div className="tsg-card tsg-ring-card">
          <Ring
            value={t.alerts > 0 ? (t.alertsDescribed / t.alerts) * 100 : null}
            label="of model calls had a read in hand"
          />
          <ol className="tsg-steps">
            <li>
              <span>
                <b>Scan</b> finds a new launch and screens out rugs
              </span>
            </li>
            <li>
              <span>
                <b>TokenSage</b> reads it: quick at once, deep when a model looks closer
              </span>
            </li>
            <li>
              <span>
                <b>Models</b> weigh the read with the market data and make the call
              </span>
            </li>
            <li>
              <span>
                <b>You</b> see the theme, lineage and flags on the alert
              </span>
            </li>
          </ol>
        </div>
      </Section>

      <Section
        id="narratives"
        share="models"
        kicker="Which narratives pay"
        title="What the calls on each theme returned"
        lede={`Model calls in the last ${PAY_SPAN[payDays]} by their coin's narrative, against the average of every call: how many points each narrative's average return under the exit plan sits above or below it, with its own return and 2x rate (and that rate's gap to the average). Thin narratives stay faded.`}
      >
        <div className="tsg-card">
          <div className="tsg-card-head tsg-pay-head">
            <span className="tsg-card-sub">Window</span>
            <div className="segmented small" role="tablist" aria-label="Narratives window">
              {PAY_WINDOWS.map((w) => (
                <button
                  key={w}
                  type="button"
                  role="tab"
                  aria-selected={w === payDays}
                  className={w === payDays ? "on" : ""}
                  onClick={() => onPayDays(w)}
                >
                  {PAY_LABEL[w]}
                </button>
              ))}
            </div>
          </div>
          <NarrativesPay pay={pay} days={payDays} />
        </div>
      </Section>
    </>
  );
}

/** The Lighthouse's "Which narratives pay" chart, over the picked window. */
function NarrativesPay({ pay, days }: { pay: LighthouseSignals | null; days: PayDays }) {
  if (!pay) return <div className="tsg-skel tsg-skel-inline" aria-busy="true" aria-label="Loading" />;
  const stale = pay.window.days !== days;
  const o = pay.outcomes;
  const rows = narratives(o.byCategory);
  const base = narrativeBaseline(o.byCategory);
  const cls = seriesClassFor(rows.slice(0, 5).map((r) => r.label));
  return (
    <div className={stale ? "stale" : undefined} aria-busy={stale}>
      <HitRates rows={rows} cls={cls} baseline={base} />
      <p className="tsg-card-sub tsg-pay-foot">
        {o.described.toLocaleString()} of {o.alerts.toLocaleString()} calls had a TokenSage read ·{" "}
        {o.graded.toLocaleString()} graded
        {base.rate2x !== null ? `, ${base.rate2x.toFixed(0)}% reached 2x` : ""}. TokenSage can answer after a
        call, so this shows what wins, not what a model knew.
      </p>
    </div>
  );
}

function LoadingSections() {
  return (
    <div className="tsg-loading" aria-busy="true" aria-label="Loading">
      {[0, 1, 2].map((i) => (
        <div key={i} className="tsg-card tsg-skel" />
      ))}
    </div>
  );
}

function Footer({ data }: { data: TokenSageShowcase | null }) {
  return (
    <footer className="tsg-foot">
      <p>
        Counts only: no coin, address or wallet is shown on this page. Figures come from the reads
        TrenchScanner has kept and are refreshed every few minutes.
      </p>
      {data ? (
        <p className="tsg-foot-meta">
          {data.rules?.version ? `TokenSage rules ${data.rules.version}` : "TokenSage"}
          {data.rules?.lexicon ? ` · lexicon ${data.rules.lexicon}` : ""}
          {` · updated ${new Date(data.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
        </p>
      ) : null}
      <a href="/" className="tsg-foot-link">
        Open TrenchScanner →
      </a>
    </footer>
  );
}

// ---------- Building blocks ----------

function Section({
  id,
  kicker,
  title,
  lede,
  share,
  children,
}: {
  id: string;
  kicker: string;
  title: string;
  lede: string;
  /** The share image this section offers, if any. */
  share?: ShareCardKind;
  children: ReactNode;
}) {
  return (
    <section className="tsg-section" id={id} aria-labelledby={`${id}-h`}>
      <div className="tsg-section-head">
        <span className="tsg-kicker">{kicker}</span>
        {share ? <ShareButton kind={share} /> : null}
      </div>
      <h2 id={`${id}-h`}>{title}</h2>
      <p className="tsg-section-lede">{lede}</p>
      {children}
    </section>
  );
}

interface RankRow {
  label: string;
  value: number;
  display: string;
  note?: string;
}

/** Ranked horizontal bars, one series. `marker` draws a reference line (e.g. the overall rate). */
function RankBars({
  rows,
  max,
  marker = null,
  empty = "Nothing read yet",
}: {
  rows: RankRow[];
  max?: number;
  marker?: number | null;
  empty?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (rows.length === 0) return <p className="tsg-empty">{empty}</p>;
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="tsg-bars" role="table">
      {rows.map((r, i) => (
        <div
          key={r.label}
          role="row"
          className={`tsg-bar${hover === i ? " is-hover" : ""}`}
          onMouseEnter={() => setHover(i)}
          onMouseLeave={() => setHover(null)}
          title={`${r.label}: ${r.display}${r.note ? ` (${r.note})` : ""}`}
        >
          <span className="tsg-bar-label" role="cell">
            {r.label}
          </span>
          <span className="tsg-bar-track" role="cell">
            <span className="tsg-bar-fill" style={{ width: `${Math.max(1.5, (r.value / top) * 100)}%` }} />
            {marker !== null ? (
              <span className="tsg-bar-marker" style={{ left: `${(marker / top) * 100}%` }} />
            ) : null}
          </span>
          <span className="tsg-bar-value num" role="cell">
            {r.display}
            {r.note ? <small>{r.note}</small> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

const SLOTS = 5;

/**
 * One 100% bar split by label, with a legend. Labels in `order` keep their slot (color follows
 * the label, not its size); the rest take the free slots biggest first, and past five fold into
 * a gray "Other".
 */
function SegmentBar({ rows, order = [] }: { rows: ShowcaseCount[]; order?: string[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const parts = useMemo(() => {
    const clean = rows.filter((r) => r.count > 0);
    const slotOf = new Map<string, number>();
    order.forEach((label, i) => i < SLOTS && slotOf.set(label, i + 1));
    const free = Array.from({ length: SLOTS }, (_, i) => i + 1).filter(
      (s) => ![...slotOf.values()].includes(s),
    );
    let other = 0;
    const out: { label: string; count: number; slot: number }[] = [];
    for (const r of [...clean].sort((a, b) => b.count - a.count)) {
      const fixed = slotOf.get(r.label);
      if (fixed !== undefined) out.push({ ...r, slot: fixed });
      else if (r.label !== "other" && r.label !== "unknown" && free.length > 0)
        out.push({ ...r, slot: free.shift()! });
      else other += r.count;
    }
    out.sort((a, b) => a.slot - b.slot);
    if (other > 0) out.push({ label: "other", count: other, slot: 0 });
    return out;
  }, [rows, order]);
  const total = parts.reduce((s, p) => s + p.count, 0);
  if (total === 0) return <p className="tsg-empty">Nothing read yet</p>;
  const active = parts.find((p) => p.label === hover);
  return (
    <div className="tsg-seg">
      <div
        className="tsg-seg-bar"
        role="img"
        aria-label={parts.map((p) => `${prettyLabel(p.label)} ${share(p.count, total)}`).join(", ")}
      >
        {parts.map((p) => (
          <span
            key={p.label}
            className={`tsg-seg-part ${p.slot ? `lh-s${p.slot}` : "lh-other"}${hover && hover !== p.label ? " is-dim" : ""}`}
            style={{ flexGrow: p.count }}
            onMouseEnter={() => setHover(p.label)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </div>
      <p className="tsg-seg-readout" aria-live="polite">
        {active
          ? `${prettyLabel(active.label)}: ${compact(active.count)} coins, ${share(active.count, total, 1)}`
          : `${compact(total)} coins`}
      </p>
      <ul className="tsg-legend">
        {parts.map((p) => (
          <li
            key={p.label}
            onMouseEnter={() => setHover(p.label)}
            onMouseLeave={() => setHover(null)}
            className={hover === p.label ? "is-hover" : undefined}
          >
            <i className={p.slot ? `lh-s${p.slot}` : "lh-other"} />
            <span>{p.label === "other" ? "Other" : prettyLabel(p.label)}</span>
            <b className="num">{share(p.count, total)}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Ring({ value, label }: { value: number | null; label: string }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const frac = Math.min(1, Math.max(0, (value ?? 0) / 100));
  return (
    <div className="tsg-ring">
      <svg
        viewBox="0 0 100 100"
        role="img"
        aria-label={`${value === null ? "–" : value.toFixed(0)}% ${label}`}
      >
        <defs>
          <linearGradient id="tsg-ring-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--brand-a)" />
            <stop offset="1" stopColor="var(--brand-b)" />
          </linearGradient>
        </defs>
        <circle cx="50" cy="50" r={r} className="tsg-ring-track" />
        <circle
          cx="50"
          cy="50"
          r={r}
          className="tsg-ring-arc"
          strokeDasharray={`${c * frac} ${c}`}
          transform="rotate(-90 50 50)"
        />
        <text x="50" y="56" textAnchor="middle" className="tsg-ring-value">
          {value === null ? "–" : `${value.toFixed(0)}%`}
        </text>
      </svg>
      <span className="tsg-ring-label">{label}</span>
    </div>
  );
}
