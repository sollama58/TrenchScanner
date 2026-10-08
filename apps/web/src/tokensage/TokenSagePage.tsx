import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { LogoMark, SageIcon } from "../components/Icons";
import {
  compact,
  dayLabel,
  hitRate,
  hourLabel,
  MIN_DAYS_FOR_DAILY,
  MIN_GRADED,
  named,
  prettyLabel,
  share,
  type ShowcaseCount,
  type ShowcaseLabel,
  type ShowcasePoint,
  type TokenSageShowcase,
} from "./showcase";

/**
 * /tokensage: TokenSage as a product, and what it has read so far. Its own page (tokensage/
 * index.html), not a dashboard tab, and not linked from the dashboard yet. Every figure is a count
 * over many coins from GET /guest/tokensage; no coin, mint or wallet is ever named.
 */

const REFRESH_MS = 5 * 60_000;

function useShowcase() {
  const [data, setData] = useState<TokenSageShowcase | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      api<TokenSageShowcase>("/guest/tokensage").then(
        (d) => {
          if (!live) return;
          setData(d);
          setError(null);
        },
        (err: unknown) => live && setError(err instanceof Error ? err.message : "Couldn't load"),
      );
    void load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return { data, error };
}

export function TokenSagePage() {
  const { data, error } = useShowcase();
  return (
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
        {data ? <Sections data={data} /> : <LoadingSections />}
      </main>
      <Footer data={data} />
    </div>
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

function Sections({ data }: { data: TokenSageShowcase }) {
  const t = data.totals;
  const themes = named(data.labels.category);
  const subThemes = named(data.labels.subcategory).slice(0, 8);
  const flags = named(data.labels.flag);
  const overall = t.alertsGraded > 0 ? (t.alertsWon2x / t.alertsGraded) * 100 : null;
  const themeRates = named(data.labels.category)
    .map((l) => ({ l, rate: hitRate(l) }))
    .filter((r): r is { l: ShowcaseLabel; rate: number } => r.rate !== null)
    .sort((a, b) => b.rate - a.rate);
  const copyRows = data.labels.copy;
  const perHour = data.daily.length < MIN_DAYS_FOR_DAILY;
  return (
    <>
      <Section
        id="volume"
        kicker="Every day"
        title={perHour ? "Reads, hour by hour" : "Reads, day by day"}
        lede={`Every coin the scanner sees gets a quick read; the ones a model weighs get the deep one too. ${
          perHour ? "Since the first read, per hour on your clock." : "The last 30 days, per UTC day."
        }`}
      >
        <ReadColumns points={perHour ? data.hourly : data.daily} perHour={perHour} />
      </Section>

      <Section
        id="themes"
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
        id="x"
        kicker="The X check"
        title="Does the link match the coin?"
        lede="On a deep read TokenSage opens the X post or profile a coin links to and checks it against the coin itself."
      >
        <div className="tsg-grid2">
          <div className="tsg-card">
            <h3>Verdict on the linked post</h3>
            <SegmentBar rows={data.labels.xVerdict} order={["about_this_coin", "related", "unrelated"]} />
            <Meter label="Average fit" value={t.avgXFit} note={`over ${compact(t.xRead)} links read`} />
          </div>
          <div className="tsg-card">
            <h3>What the link is</h3>
            <RankBars
              rows={named(data.anatomy.xRelation).map((r) => ({
                label: prettyLabel(r.label),
                value: r.count,
                display: compact(r.count),
              }))}
            />
          </div>
        </div>
      </Section>

      <Section
        id="flags"
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
            <h3>What the logo shows</h3>
            <RankBars
              rows={named(data.anatomy.logo).map((r) => ({
                label: prettyLabel(r.label),
                value: r.count,
                display: compact(r.count),
              }))}
            />
          </div>
          <div className="tsg-card">
            <h3>Where the creator fee goes</h3>
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
        <div className="tsg-grid2">
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
          <div className="tsg-card">
            <h3>2x rate of model calls, by theme</h3>
            <p className="tsg-card-sub">
              Graded calls only; themes with fewer than {MIN_GRADED} are left out.
              {overall !== null ? ` All calls: ${overall.toFixed(0)}%.` : ""}
            </p>
            <RankBars
              max={100}
              marker={overall}
              rows={themeRates.map(({ l, rate }) => ({
                label: prettyLabel(l.label),
                value: rate,
                display: `${rate.toFixed(0)}%`,
                note: `${compact(l.graded)} calls`,
              }))}
              empty="Not enough graded calls yet"
            />
          </div>
        </div>
      </Section>
    </>
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
  children,
}: {
  id: string;
  kicker: string;
  title: string;
  lede: string;
  children: ReactNode;
}) {
  return (
    <section className="tsg-section" id={id} aria-labelledby={`${id}-h`}>
      <span className="tsg-kicker">{kicker}</span>
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

/** A 0-1 score as a meter, with its value in words. */
function Meter({ label, value, note }: { label: string; value: number | null; note: string }) {
  return (
    <div className="tsg-meter">
      <div className="tsg-meter-head">
        <span>{label}</span>
        <b className="num">{value === null ? "–" : value.toFixed(2)}</b>
      </div>
      <div className="tsg-meter-track">
        <span style={{ width: `${(value ?? 0) * 100}%` }} />
      </div>
      <span className="tsg-tile-note">{note}</span>
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

/** Stacked columns per day or hour: deep reads at the base, quick reads on top, with a hover readout. */
function ReadColumns({ points, perHour }: { points: ShowcasePoint[]; perHour: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const rows = points.map((d) => ({ ...d, quick: Math.max(0, d.described - d.deep) }));
  const label = (iso: string, long = false) => (perHour ? hourLabel(iso, long) : dayLabel(iso, long));
  const peak = Math.max(1, ...rows.map((r) => r.deep + r.quick));
  const step = niceStep(peak);
  const top = Math.ceil(peak / step) * step;
  const H = 220;
  const padL = 44;
  const padB = 24;
  const plotW = width - padL - 4;
  const plotH = H - padB - 8;
  const band = plotW / Math.max(1, rows.length);
  const barW = Math.min(18, band * 0.68);
  const y = (v: number) => 8 + plotH - (v / top) * plotH;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const every = Math.ceil(rows.length / Math.max(2, Math.floor(plotW / 56)));
  const h = hover !== null ? rows[hover] : null;
  return (
    <div className="tsg-card">
      <div className="tsg-chart-head">
        <ul className="tsg-legend inline">
          <li>
            <i className="lh-s1" />
            <span>Deep reads</span>
          </li>
          <li>
            <i className="lh-s2" />
            <span>Quick reads only</span>
          </li>
        </ul>
        <span className="tsg-readout" aria-live="polite">
          {h
            ? `${label(h.at, true)} · ${compact(h.deep)} deep · ${compact(h.quick)} quick`
            : `Busiest ${perHour ? "hour" : "day"}: ${compact(peak)} coins described`}
        </span>
      </div>
      <div ref={box} className="tsg-cols">
        <svg
          width={width}
          height={H}
          role="img"
          aria-label={`Coins described per ${perHour ? "hour" : "day"}`}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line x1={padL} x2={width} y1={y(v)} y2={y(v)} className="tsg-grid" />
              <text x={padL - 8} y={y(v) + 4} textAnchor="end" className="tsg-axis">
                {compact(v)}
              </text>
            </g>
          ))}
          {rows.map((r, i) => {
            const x = padL + i * band + (band - barW) / 2;
            const deepTop = y(r.deep);
            const allTop = y(r.deep + r.quick);
            const gap = r.deep > 0 && r.quick > 0 ? 2 : 0;
            return (
              <g
                key={r.at}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                className={hover !== null && hover !== i ? "is-dim" : undefined}
              >
                <rect x={padL + i * band} y={8} width={band} height={plotH} fill="transparent" />
                {r.deep > 0 ? (
                  <path d={colPath(x, y(0), deepTop, barW, r.quick === 0)} className="tsg-col s1" />
                ) : null}
                {r.quick > 0 ? (
                  <path d={colPath(x, deepTop - gap, allTop, barW, true)} className="tsg-col s2" />
                ) : null}
                {i % every === 0 || i === rows.length - 1 ? (
                  <text x={x + barW / 2} y={H - 6} textAnchor="middle" className="tsg-axis">
                    {label(r.at)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

/** A column from `base` up to `top`, its data end rounded when `round`. */
function colPath(x: number, base: number, top: number, w: number, round: boolean) {
  const r = round ? Math.min(4, w / 2, Math.max(0, base - top)) : 0;
  return `M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${base} Z`;
}

/** A round tick step: 1, 2 or 5 times a power of ten, about four ticks. */
function niceStep(peak: number) {
  const raw = peak / 4;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const norm = raw / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
}
