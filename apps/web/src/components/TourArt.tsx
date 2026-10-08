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

/** Study, exam, rank, lead: the models' loop. */
export function CompeteArt() {
  const nodes = [
    { x: 280, y: 34, label: "Study", sub: "recent coins" },
    { x: 470, y: 110, label: "Exam", sub: "unseen weeks" },
    { x: 280, y: 186, label: "Rank", sub: "toward the goal" },
    { x: 90, y: 110, label: "Lead", sub: "best is default" },
  ];
  return (
    <Art label="The models study, take an exam, get ranked, and the best one leads, every few hours">
      <ellipse className="orbit" cx="280" cy="110" rx="190" ry="76" />
      <path className="flow" d="M352 50 Q420 62 446 86" markerEnd="url(#tour-arrow)" />
      <path className="flow" d="M446 134 Q420 158 352 170" markerEnd="url(#tour-arrow)" />
      <path className="flow" d="M208 170 Q140 158 114 134" markerEnd="url(#tour-arrow)" />
      <path className="flow" d="M114 86 Q140 62 208 50" markerEnd="url(#tour-arrow)" />
      <g className="podium" transform="translate(238 86)">
        <rect x="0" y="22" width="26" height="30" rx="3" />
        <rect x="28" y="6" width="26" height="46" rx="3" className="first" />
        <rect x="56" y="30" width="26" height="22" rx="3" />
        <path className="crown" d="M31 0 L35 -10 L41 -3 L47 -10 L51 0 Z" />
      </g>
      {nodes.map((n) => (
        <g key={n.label} transform={`translate(${n.x - 62} ${n.y - 22})`}>
          <rect className="box model" width="124" height="44" rx="22" />
          <text x="62" y="20" className="label model" textAnchor="middle">
            {n.label}
          </text>
          <text x="62" y="35" className="cap small" textAnchor="middle">
            {n.sub}
          </text>
        </g>
      ))}
      <Defs />
    </Art>
  );
}

/** Price after the alert: the grading lines and two example paths. */
export function GradeArt() {
  const x = (min: number) => 64 + (min / 60) * 460;
  const y = (mult: number) => 160 - Math.log2(mult) * 34;
  const levels: [number, string][] = [
    [10, "10x"],
    [4, "4x"],
    [2, "2x"],
    [1, "Alert"],
    [0.5, "−50%"],
  ];
  const win = [
    [0, 1],
    [4, 1.3],
    [8, 1.6],
    [11, 2.3],
    [16, 2.8],
    [22, 3.3],
    [27, 4.6],
    [36, 4.1],
    [44, 6.5],
    [52, 8.2],
    [57, 11],
  ]
    .map(([m, v], i) => `${i ? "L" : "M"}${x(m!).toFixed(1)} ${y(v!).toFixed(1)}`)
    .join(" ");
  const loss = [
    [0, 1],
    [3, 0.9],
    [6, 0.72],
    [9, 0.6],
    [11, 0.5],
  ]
    .map(([m, v], i) => `${i ? "L" : "M"}${x(m!).toFixed(1)} ${y(v!).toFixed(1)}`)
    .join(" ");
  return (
    <Art label="A coin that doubles in 15 minutes is a win; one that halves first is stopped out">
      <rect className="zone bad" x={x(0)} y={y(0.5)} width={x(60) - x(0)} height={214 - y(0.5)} />
      {levels.map(([m, label]) => (
        <g key={label}>
          <path className={`grid${m === 1 ? " base" : ""}`} d={`M${x(0)} ${y(m)} H${x(60)}`} />
          <text x={x(0) - 8} y={y(m) + 4} className="cap small" textAnchor="end">
            {label}
          </text>
        </g>
      ))}
      {[15, 30, 60].map((m) => (
        <g key={m}>
          <path className="grid deadline" d={`M${x(m)} ${y(16)} V${y(0.4)}`} />
          <text x={x(m)} y={y(0.4) + 14} className="cap small" textAnchor={m === 60 ? "end" : "middle"}>
            {m} min
          </text>
        </g>
      ))}
      <path className="path win" d={win} />
      <path className="path loss" d={loss} />
      <Badge cx={x(15)} cy={y(2)} text="✓" />
      <Badge cx={x(30)} cy={y(4)} text="✓✓" />
      <Badge cx={x(57)} cy={y(10)} text="✓✓✓" />
      <g className="badge bad" transform={`translate(${x(11)} ${y(0.5)})`}>
        <circle r="11" />
        <text y="4" textAnchor="middle">
          ✕
        </text>
      </g>
    </Art>
  );
}

function Badge({ cx, cy, text }: { cx: number; cy: number; text: string }) {
  const w = 14 + text.length * 8;
  return (
    <g className="badge good" transform={`translate(${cx} ${cy})`}>
      <rect x={-w / 2} y="-11" width={w} height="22" rx="11" />
      <text y="4" textAnchor="middle">
        {text}
      </text>
    </g>
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

/** A clock and a wallet: guests see calls a few minutes late. */
export function GuestArt({ delay }: { delay: number }) {
  return (
    <Art label={`As a guest you see each call ${delay} minutes late; connect a wallet to get them live`}>
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
