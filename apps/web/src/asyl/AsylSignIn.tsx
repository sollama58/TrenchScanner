import { useRef, useState } from "react";
import { SignIn } from "../components/SignIn";
import { signInUrl } from "../returnTo";
import { GraphView, MapLegend } from "./GraphView";
import type { AsylEdge, AsylGraph } from "./graph";
import { newLayout } from "./layout";

/**
 * Asyl's own sign-in page (user ask 2026-10-24): TrenchScanner's sign-in page in Asyl's look, with
 * an example map where the dashboard shows an example alert. Both sites share the one session
 * cookie on api.trenchscanner.app, so signing in here signs in on TrenchScanner too, and back.
 */

const SENT_KEY = "asyl:sent-to-sign-in";

/** Signs in on TrenchScanner instead, which sends the visitor back here (returnTo.ts). */
export function goSignIn(): void {
  try {
    sessionStorage.setItem(SENT_KEY, String(Date.now()));
  } catch {
    // Storage blocked: the redirect still works.
  }
  window.location.assign(signInUrl(window.location.href));
}

export function AsylSignIn({ onSignedIn }: { onSignedIn: () => void }) {
  return (
    <div className="asyl-signin">
      <SignIn onSignedIn={onSignedIn} site="asyl" intro={<AsylIntro />} showcase={<ExampleMap />} />
    </div>
  );
}

function AsylIntro() {
  return (
    <div className="landing-intro asyl-signin-intro">
      <h1 className="asyl-wordmark">ASYL</h1>
      <p className="lead">Who&apos;s behind it? Map the wallets around a coin or a wallet.</p>
      <ul className="landing-points">
        <li>
          <span className="eyebrow">Wallets</span>
          <p>
            Who funded it, who it pays, its side wallets, and the wallets that buy the same coins with it.
          </p>
        </li>
        <li>
          <span className="eyebrow">Coins</span>
          <p>Its deployer and top holders, and the funding and transfers that tie them together.</p>
        </li>
        <li>
          <span className="eyebrow">Maps</span>
          <p>Label wallets, save maps, and share them as a link or an image.</p>
        </li>
      </ul>
      <p className="faint small">
        One sign-in with{" "}
        <a href="https://trenchscanner.app" className="asyl-link">
          TrenchScanner
        </a>
        . Trouble signing in here?{" "}
        <button type="button" className="asyl-link" onClick={goSignIn}>
          Sign in on TrenchScanner
        </button>
        .
      </p>
    </div>
  );
}

// The example: made-up addresses and names, drawn as a real map would draw them.
const COIN = "MASi45ub7Qe4ZE36UT5G6cU4ud8Fhhe4deS4F3cw9KTA";
const DEV = "b8dLcukC7edhDQ7cn5d4gEYkbUrMWeWQLGsCmrG6dLaY";
const FUNDER = "yNoVKf58ZTBqNAYT3j5qcdsyuMNmPfYetW5v6JXmj54o";
const BUNDLE = [
  "mLidkuVKnRyjP2WPBg8Y4ErK9pGSSxY6BVScJy9uUxcJ",
  "nTPkyRFA6CAFjF1YveCHK1ATbQgdM9mwZgikp4Wzxrxk",
  "tcSSSS7XhS4D5EVB8Nf471dAb7Qg25xEgRAhHPfQX88w",
  "YWXXL6A7pNpHXvmBa2EaQAmb2qaLix6mwHaQBPrFbbrZ",
];
const KOL = "NhFgtsqwDtGuSptFDaYPo22sJXHDmfPVtoPQ6F7FXDNE";
const SIDE = "Xgzgv1XiPti6vj8RsnqDXyCUshN6toSWSp6oBB92AezW";

const link = (a: string, b: string, kind: AsylEdge["kind"], weight: number, label: string): AsylEdge => ({
  a,
  b,
  kind,
  weight,
  label,
  source: "stored",
  mint: kind === "holds" || kind === "traded" || kind === "created" ? COIN : null,
});

export const EXAMPLE_MAP: AsylGraph = {
  nodes: [
    { id: COIN, kind: "token", name: "$EXAMPLE", tags: [], deployer: DEV },
    { id: DEV, kind: "wallet", name: "Deployer", tags: ["dev"] },
    { id: FUNDER, kind: "wallet", name: "Funder", tags: ["farm"] },
    ...BUNDLE.map((id, i) => ({ id, kind: "wallet" as const, name: `Bundle ${i + 1}`, tags: [] })),
    { id: KOL, kind: "wallet", name: "A KOL", tags: ["kol"] },
    { id: SIDE, kind: "wallet", name: "KOL side", tags: ["kol-side"] },
  ],
  edges: [
    link(DEV, COIN, "created", 1, "Deployed it"),
    link(FUNDER, DEV, "funded", 2, "Funded · 2 SOL"),
    ...BUNDLE.map((id, i) => link(FUNDER, id, "funded", 1.5 - i * 0.2, "Funded · 1.5 SOL")),
    ...BUNDLE.map((id, i) => link(id, COIN, "holds", 6 - i, `Holds ${6 - i}%`)),
    link(BUNDLE[0]!, BUNDLE[1]!, "transfer", 1.2, "Sent 1.2% of supply"),
    link(KOL, COIN, "traded", 3, "1 buy, 1 sell · +2.10 SOL"),
    link(KOL, SIDE, "side", 1, "Side wallet"),
    link(KOL, BUNDLE[2]!, "cotrade", 3, "3 coins within minutes"),
  ],
};

/** Where the dashboard shows an example alert: an example map, live to drag and select. */
function ExampleMap() {
  const layout = useRef(newLayout());
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <section className="landing-example asyl-signin-example" aria-labelledby="asyl-example-title">
      <p className="eyebrow">Maps</p>
      <h2 id="asyl-example-title">What a map looks like</h2>
      <p className="muted small">
        A made-up coin: one funder paid its deployer and four wallets that hold it, a bundle.
      </p>
      <div className="asyl-signin-map">
        <GraphView
          graph={EXAMPLE_MAP}
          layout={layout.current}
          selected={selected}
          focus={COIN}
          onSelect={setSelected}
          layoutKey="example"
          readOnly
        />
        <MapLegend graph={EXAMPLE_MAP} startOpen={false} />
      </div>
    </section>
  );
}
