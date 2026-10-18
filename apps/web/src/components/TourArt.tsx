import { GaugeDial } from "./WeatherGauge";

/**
 * The pictures in the Live tab's tour (AboutModal). Plain inline SVG on a 560x220 canvas, colored
 * through the .tour-art classes in styles.css so they follow the light and dark themes.
 */

function Art({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <svg className="tour-art" viewBox="0 0 560 220" role="img" aria-label={label}>
      {children}
    </svg>
  );
}

function Coin({ x, y, r = 9, tone = "muted" }: { x: number; y: number; r?: number; tone?: string }) {
  return (
    <g className={`coin ${tone}`}>
      <circle cx={x} cy={y} r={r} />
      <circle cx={x} cy={y} r={r * 0.55} className="coin-ring" />
    </g>
  );
}

/** Many launches in, a few alerts out. */
export function FunnelArt() {
  // A loose, fixed scatter so the picture doesn't change between renders.
  const crowd: [number, number][] = [];
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 6; col++) {
      crowd.push([40 + col * 28 + (row % 2) * 12, 34 + row * 28 + ((col * 7) % 5)]);
    }
  }
  return (
    <Art label="Lots of new coins go into the scanner and only a few come out as alerts">
      {crowd.map(([x, y], i) => (
        <Coin key={i} x={x} y={y} r={8} tone={i % 5 === 0 ? "dim" : "muted"} />
      ))}
      <path className="flow" d="M206 110 H226" markerEnd="url(#tour-arrow)" />
      <path className="funnel" d="M232 40 H352 L310 112 V176 H274 V112 Z" />
      <circle className="lens" cx="292" cy="72" r="15" />
      <path className="lens-handle" d="M303 83 L313 93" />
      <path className="flow" d="M318 150 H392" markerEnd="url(#tour-arrow)" />
      <Coin x={424} y={150} r={15} tone="good" />
      <Coin x={466} y={128} r={15} tone="good" />
      <Coin x={506} y={150} r={15} tone="good" />
      <g className="bell" transform="translate(452 42)">
        <path d="M6 18a12 12 0 0 1 24 0c0 14 6 18 6 18H0s6-4 6-18" />
        <path d="M14 42a4 4 0 0 0 8 0" />
      </g>
      <path className="ping" d="M438 52 a26 26 0 0 1 0 -22 M498 52 a26 26 0 0 0 0 -22" />
      <text x="120" y="212" className="cap" textAnchor="middle">
        Hundreds of new coins an hour
      </text>
      <text x="292" y="212" className="cap" textAnchor="middle">
        Scanner
      </text>
      <text x="466" y="212" className="cap" textAnchor="middle">
        A few worth a look
      </text>
      <Defs />
    </Art>
  );
}

/** Coins file through a shield; the bad ones drop out. */
export function BouncerArt() {
  return (
    <Art label="Every coin goes through a safety check; the risky ones are thrown out">
      <path className="belt" d="M20 110 H540" />
      <Coin x={50} y={92} r={13} />
      <Coin x={92} y={92} r={13} />
      <Coin x={134} y={92} r={13} />
      <Coin x={176} y={92} r={13} />
      <g transform="translate(236 34)">
        <path className="shield" d="M44 0 L88 16 V58 C88 92 66 118 44 126 C22 118 0 92 0 58 V16 Z" />
        <path className="shield-tick" d="M24 62 L39 77 L66 46" />
      </g>
      <Coin x={378} y={92} r={13} tone="good" />
      <Coin x={420} y={92} r={13} tone="good" />
      <path className="flow" d="M444 92 H500" markerEnd="url(#tour-arrow)" />
      <text x="520" y="80" className="cap good" textAnchor="middle">
        In
      </text>
      <path className="flow bad" d="M330 118 Q350 150 356 176" markerEnd="url(#tour-arrow-bad)" />
      <g className="bin">
        <path d="M330 182 H410 L402 214 H338 Z" />
      </g>
      <Coin x={358} y={196} r={9} tone="bad" />
      <Coin x={382} y={198} r={9} tone="bad" />
      <text x="440" y="204" className="cap bad">
        Out
      </text>
      <Defs />
    </Art>
  );
}

/** Your filter and the models both feed the Live feed. */
export function TwoWaysArt() {
  return (
    <Art label="Your own filter and the models both send coins to your feed">
      <g transform="translate(24 22)">
        <rect className="box mine" width="190" height="76" rx="14" />
        <g className="sliders">
          <path d="M20 26 H76 M20 50 H76" />
          <circle cx="36" cy="26" r="6" />
          <circle cx="62" cy="50" r="6" />
        </g>
        <text x="92" y="34" className="label mine">
          Your filter
        </text>
        <text x="92" y="54" className="cap">
          rules you set
        </text>
      </g>
      <g transform="translate(24 122)">
        <rect className="box model" width="190" height="76" rx="14" />
        <g className="robot">
          <rect x="22" y="22" width="44" height="36" rx="9" />
          <path d="M44 22 V12" />
          <circle cx="44" cy="10" r="3" />
          <circle cx="35" cy="38" r="4" className="eye" />
          <circle cx="53" cy="38" r="4" className="eye" />
        </g>
        <text x="84" y="34" className="label model">
          Models
        </text>
        <text x="84" y="54" className="cap">
          trained robots
        </text>
      </g>
      <path className="flow" d="M222 60 C290 60 300 110 352 110" markerEnd="url(#tour-arrow)" />
      <path className="flow" d="M222 160 C290 160 300 110 352 110" markerEnd="url(#tour-arrow)" />
      <g transform="translate(366 46)">
        <rect className="card back" x="16" y="0" width="150" height="100" rx="12" />
        <rect className="card mid" x="8" y="12" width="150" height="100" rx="12" />
        <rect className="card front" x="0" y="24" width="150" height="100" rx="12" />
        <rect className="line strong" x="16" y="42" width="70" height="9" rx="4" />
        <rect className="line" x="16" y="62" width="112" height="7" rx="3.5" />
        <rect className="line" x="16" y="78" width="92" height="7" rx="3.5" />
        <rect className="chip good" x="16" y="98" width="46" height="14" rx="7" />
      </g>
      <text x="449" y="206" className="cap" textAnchor="middle">
        Your feed
      </text>
      <Defs />
    </Art>
  );
}

/** The Lighthouse's weather gauge, with a made-up hot reading. */
export function WeatherArt() {
  return (
    <GaugeDial
      ratio={1.35}
      label="A gauge from cold to hot: how often coins are doubling compared with the past week"
      caption="Coins doubling now vs. the past week"
    />
  );
}

/** A bubble (x, y, radius, % of supply) on the tour's pictures of the bubble map. */
type Bub = [number, number, number, string];

function Bubble({ b: [x, y, r, label], tone = "" }: { b: Bub; tone?: string }) {
  return (
    <g>
      <circle className={`bm-bubble ${tone}`} cx={x} cy={y} r={r} />
      <text x={x} y={y + (r >= 15 ? 4 : 3)} className={`bm-pct${r < 15 ? " small" : ""}`} textAnchor="middle">
        {label}
      </text>
    </g>
  );
}

/** A funder, drawn as the map draws it: a small diamond. */
function Funder({ x, y, tone }: { x: number; y: number; tone: string }) {
  return (
    <rect
      className={`bm-funder ${tone}`}
      x="-6"
      y="-6"
      width="12"
      height="12"
      rx="2"
      transform={`translate(${x} ${y}) rotate(45)`}
    />
  );
}

/** The bubble map as it reads now: clusters with their shares, the Linked tile and the group list. */
export function BubblesArt() {
  const fa = { x: 120, y: 100 };
  const a: Bub[] = [
    [70, 52, 24, "4.2%"],
    [176, 58, 20, "2.1%"],
    [60, 150, 16, "0.8%"],
    [150, 160, 13, "0.5%"],
  ];
  const fb = { x: 262, y: 150 };
  const b: Bub[] = [
    [230, 110, 22, "3.1%"],
    [306, 122, 15, "1.4%"],
    [290, 186, 10, "0.6%"],
  ];
  const lone: Bub[] = [
    [300, 40, 18, "2.4%"],
    [345, 78, 9, "0.3%"],
    [350, 170, 8, "0.2%"],
  ];
  const rows = [
    { tone: "a", name: "Funder 7Kq…", sub: "4 wallets", pct: "7.6%", on: true },
    { tone: "b", name: "Funder Hx2…", sub: "3 wallets", pct: "5.1%", on: false },
    { tone: "kol", name: "KOL", sub: "3 wallets", pct: "4.7%", on: false },
  ];
  return (
    <Art label="A bubble map: two coloured clusters of top holders, each tied to the funder that paid for them and labelled with its share of supply, a risky wallet ringed in red, the Linked tile reading 7 of 25 holding 12.7%, and the list of groups beside it">
      {a.map(([x, y], i) => (
        <path key={`la${i}`} className="bm-link a" d={`M${fa.x} ${fa.y} L${x} ${y}`} />
      ))}
      {b.map(([x, y], i) => (
        <path key={`lb${i}`} className="bm-link b" d={`M${fb.x} ${fb.y} L${x} ${y}`} />
      ))}
      {a.map((n, i) => (
        <Bubble key={`a${i}`} b={n} tone="a" />
      ))}
      {b.map((n, i) => (
        <Bubble key={`b${i}`} b={n} tone="b" />
      ))}
      {lone.map((n, i) => (
        <Bubble key={`o${i}`} b={n} />
      ))}
      <Bubble b={[222, 30, 12, "0.9%"]} tone="risky" />
      <Funder x={fa.x} y={fa.y} tone="a" />
      <Funder x={fb.x} y={fb.y} tone="b" />
      <text x="185" y="212" className="cap" textAnchor="middle">
        Same colour, same funder
      </text>

      <g transform="translate(380 14)">
        <rect className="bm-tile" width="168" height="48" rx="10" />
        <text x="12" y="19" className="cap small">
          Linked
        </text>
        <text x="12" y="38" className="label">
          7/25 (12.7%)
        </text>
      </g>
      <text x="380" y="82" className="cap small">
        CLUSTERS AND KOLS
      </text>
      {rows.map((r, i) => (
        <g key={r.name} transform={`translate(380 ${90 + i * 36})`}>
          <rect className={`bm-row ${r.tone}${r.on ? " on" : ""}`} width="168" height="30" rx="8" />
          <circle className={`bm-dot ${r.tone}`} cx="14" cy="15" r="5" />
          <text x="26" y="13" className="bm-row-name">
            {r.name}
          </text>
          <text x="26" y="25" className="cap small">
            {r.sub}
          </text>
          <text x="158" y="19" className="bm-row-pct" textAnchor="end">
            {r.pct}
          </text>
        </g>
      ))}
      <text x="464" y="212" className="cap" textAnchor="middle">
        Tap one for its wallets
      </text>
    </Art>
  );
}

/** A KOL on the map with the wallets tied to it, and the supply they hold together. */
export function KolArt() {
  const kol: Bub = [150, 104, 30, "6.5%"];
  const known: Bub = [56, 52, 16, "2.1%"];
  const funded: Bub = [62, 160, 14, "1.4%"];
  const side: Bub = [268, 50, 15, "1.2%"];
  const same: Bub = [292, 160, 13, "0.9%"];
  const fx = { x: 228, y: 150 };
  const tied = [
    ["kol", "1 Known Side"],
    ["kol", "1 KOL Funded"],
    ["side", "1 probable side"],
    ["a", "1 same funder"],
  ];
  return (
    <Art label="A KOL's bubble in gold, tied to a Known Side and a wallet it funded, a probable side wallet on a dotted gold line, and a holder sharing its funder: together 12.1% of supply">
      <path className="bm-link kol" d={`M${kol[0]} ${kol[1]} L${known[0]} ${known[1]}`} />
      <path className="bm-link kol" d={`M${kol[0]} ${kol[1]} L${funded[0]} ${funded[1]}`} />
      <path className="bm-link side" d={`M${kol[0]} ${kol[1]} L${side[0]} ${side[1]}`} />
      <path className="bm-link a" d={`M${fx.x} ${fx.y} L${kol[0]} ${kol[1]}`} />
      <path className="bm-link a" d={`M${fx.x} ${fx.y} L${same[0]} ${same[1]}`} />
      <Bubble b={kol} tone="kol" />
      <Bubble b={known} tone="kol" />
      <Bubble b={funded} tone="kol" />
      <Bubble b={side} />
      <Bubble b={same} tone="a" />
      <Funder x={fx.x} y={fx.y} tone="a" />
      <g transform={`translate(${kol[0]} ${kol[1] + 44})`}>
        <rect className="bm-tag kol" x="-18" y="-10" width="36" height="16" rx="4" />
        <text y="2" className="bm-tag-text" textAnchor="middle">
          KOL
        </text>
      </g>
      <g transform={`translate(${side[0] + 48} ${side[1] - 4})`}>
        <rect className="bm-tag side" x="-24" y="-11" width="48" height="18" rx="9" />
        <text y="2" className="bm-tag-text" textAnchor="middle">
          side?
        </text>
      </g>
      <text x={known[0]} y={known[1] - 24} className="cap small" textAnchor="middle">
        Known Side
      </text>
      <text x={funded[0]} y={funded[1] + 30} className="cap small" textAnchor="middle">
        KOL Funded
      </text>
      <text x={same[0]} y={same[1] + 28} className="cap small" textAnchor="middle">
        Same funder
      </text>

      <g transform="translate(360 18)">
        <rect className="bm-row kol on" width="188" height="176" rx="12" />
        <circle className="bm-dot kol" cx="18" cy="22" r="5" />
        <text x="30" y="26" className="bm-row-name">
          KOL group
        </text>
        <text x="16" y="62" className="label big">
          12.1%
        </text>
        <text x="16" y="80" className="cap small">
          of supply it may control
        </text>
        {tied.map(([tone, text], i) => (
          <g key={text} transform={`translate(16 ${102 + i * 18})`}>
            <circle className={`bm-dot ${tone}`} cx="4" cy="-4" r="4" />
            <text x="14" y="0" className="cap small">
              {text}
            </text>
          </g>
        ))}
      </g>
    </Art>
  );
}

export function YoursArt() {
  const filters: [string, boolean][] = [
    ["Fast movers", true],
    ["Low KOL bundled", true],
    ["Big volume", false],
  ];
  return (
    <Art label="Three saved filters, two switched on and one off; a slider hiding alerts below a market cap; Telegram sending its own models' alerts">
      {filters.map(([name, on], i) => (
        <g key={name} transform={`translate(16 ${28 + i * 44})`}>
          <rect className="box mine" width="172" height="34" rx="10" />
          <text x="12" y="22" className={`cap${on ? "" : " off"}`}>
            {name}
          </text>
          <g transform="translate(130 9)" className={`tour-switch${on ? " on" : ""}`}>
            <rect width="30" height="16" rx="8" />
            <circle cx={on ? 22 : 8} cy="8" r="6" />
          </g>
        </g>
      ))}
      <text x="102" y="206" className="cap" textAnchor="middle">
        Each filter on or off
      </text>

      <text x="212" y="40" className="cap small">
        Hide below
      </text>
      <text x="364" y="40" className="label" textAnchor="end">
        $10k
      </text>
      <path className="slider-track" d="M212 58 H364" />
      <path className="slider-fill" d="M212 58 H262" />
      <circle className="slider-knob" cx="262" cy="58" r="8" />
      <g transform="translate(212 82)" opacity="0.35">
        <rect className="card front" width="152" height="40" rx="10" />
        <rect className="line strong" x="12" y="12" width="56" height="8" rx="4" />
        <text x="140" y="27" className="cap small" textAnchor="end">
          Now $6k
        </text>
      </g>
      <g transform="translate(212 132)">
        <rect className="card front" width="152" height="40" rx="10" />
        <rect className="line strong" x="12" y="12" width="56" height="8" rx="4" />
        <text x="140" y="27" className="cap small good" textAnchor="end">
          Now $48k
        </text>
      </g>
      <text x="288" y="206" className="cap" textAnchor="middle">
        Fallen coins tucked away
      </text>

      <g transform="translate(392 40)">
        <rect className="box model" width="156" height="132" rx="16" />
        <path className="plane" d="M30 54 L94 28 L80 92 L64 70 Z M64 70 L94 28" />
        <text x="78" y="112" className="label model" textAnchor="middle">
          Telegram
        </text>
      </g>
      <text x="470" y="206" className="cap" textAnchor="middle">
        Its own models
      </text>
    </Art>
  );
}

/** The top 250 holders, an hour's wait, and what Pro Mode opens. */
export function ProArt() {
  const rows: [string, string, boolean][] = [
    ["#1", "4.1%", false],
    ["#2", "2.7%", false],
    ["#…", "", false],
    ["#250", "You", true],
  ];
  const perks = ["Trade, no fee", "Quick buy", "Portfolio"];
  return (
    <Art label="Your wallet at #250 of the top $ASDFASDFA holders; after an hour in the top 250 Pro Mode switches on, with trading, quick buy and the Portfolio">
      {rows.map(([rank, note, you], i) => (
        <g key={rank} transform={`translate(16 ${22 + i * 40})`}>
          <rect className={`box${you ? " mine" : ""}`} width="176" height="32" rx="10" />
          <text x="14" y="21" className={`label${you ? " mine" : ""}`}>
            {rank}
          </text>
          <rect
            className={`line${you ? " strong" : ""}`}
            x="66"
            y="12"
            width={you ? 40 : 70 - i * 12}
            height="8"
            rx="4"
          />
          <text x="164" y="21" className={`cap small${you ? " good" : ""}`} textAnchor="end">
            {note}
          </text>
        </g>
      ))}
      <text x="104" y="206" className="cap" textAnchor="middle">
        Top 250 holders
      </text>

      <path className="flow" d="M204 104 H236" markerEnd="url(#tour-arrow)" />
      <circle className="lens" cx="280" cy="104" r="30" />
      <path className="lens-handle" d="M280 104 V84 M280 104 L294 112" />
      <text x="280" y="160" className="label" textAnchor="middle">
        1 hour
      </text>
      <path className="flow" d="M324 104 H356" markerEnd="url(#tour-arrow)" />
      <text x="280" y="206" className="cap" textAnchor="middle">
        Stay in
      </text>

      <g transform="translate(372 22)">
        <rect className="box model" width="176" height="160" rx="16" />
        <text x="88" y="30" className="label model" textAnchor="middle">
          Pro Mode
        </text>
        {perks.map((perk, i) => (
          <g key={perk} transform={`translate(16 ${48 + i * 34})`}>
            <rect className="card front" width="144" height="26" rx="8" />
            <text x="72" y="18" className="cap small" textAnchor="middle">
              {perk}
            </text>
          </g>
        ))}
      </g>
      <text x="460" y="206" className="cap" textAnchor="middle">
        Switches on by itself
      </text>
      <Defs />
    </Art>
  );
}

/** A clock and a wallet: guests see calls a few minutes late. */
export function GuestArt({ delay }: { delay: number }) {
  return (
    <Art label={`As a guest you see each alert ${delay} minutes late; connect a wallet to get them live`}>
      <g transform="translate(150 110)">
        <circle className="clock" r="70" />
        <path className="clock-hand" d="M0 0 V-46 M0 0 L30 16" />
        <circle className="hub" r="6" />
      </g>
      <text x="150" y="208" className="cap" textAnchor="middle">
        Guest: {delay} min late
      </text>
      <path className="flow" d="M250 110 H318" markerEnd="url(#tour-arrow)" />
      <g transform="translate(340 62)">
        <rect className="box model" width="150" height="96" rx="16" />
        <rect className="wallet-flap" x="96" y="34" width="54" height="30" rx="8" />
        <circle className="wallet-dot" cx="114" cy="49" r="5" />
        <text x="16" y="40" className="label model">
          Wallet
        </text>
        <text x="16" y="60" className="cap small">
          connected
        </text>
      </g>
      <text x="415" y="208" className="cap good" textAnchor="middle">
        Live, plus your own filters
      </text>
      <Defs />
    </Art>
  );
}

function Defs() {
  return (
    <defs>
      <marker
        id="tour-arrow"
        viewBox="0 0 10 10"
        refX="8"
        refY="5"
        markerWidth="7"
        markerHeight="7"
        orient="auto"
      >
        <path d="M0 0 L10 5 L0 10 Z" className="arrow-head" />
      </marker>
      <marker
        id="tour-arrow-bad"
        viewBox="0 0 10 10"
        refX="8"
        refY="5"
        markerWidth="7"
        markerHeight="7"
        orient="auto"
      >
        <path d="M0 0 L10 5 L0 10 Z" className="arrow-head bad" />
      </marker>
    </defs>
  );
}
