import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Card } from "../api";
import { scopeSampleCard } from "../scopeSample";
import { LandingShowcase, SignIn, SignInPanel } from "./SignIn";
import type { WalletOption } from "../wallet";
import type { PrivyConfig } from "../privyBridge";

vi.mock("../appearance", async () => {
  const actual = await vi.importActual<typeof import("../appearance")>("../appearance");
  return { ...actual, useAppearance: () => actual.DEFAULT_APPEARANCE };
});

vi.mock("../proTrade", async () => {
  const actual = await vi.importActual<typeof import("../proTrade")>("../proTrade");
  return { ...actual, useTradeSettings: () => actual.DEFAULT_TRADE_SETTINGS };
});

vi.mock("../wallet", async () => {
  const actual = await vi.importActual<typeof import("../wallet")>("../wallet");
  return {
    ...actual,
    walletOptions: () => [],
    onWalletsChanged: () => () => {},
  };
});

const now = Date.parse("2026-10-22T15:00:00.000Z");

function namedCard(symbol: string): Card {
  const card = scopeSampleCard(now);
  card.id = symbol;
  card.token.symbol = symbol;
  card.token.name = symbol;
  return card;
}

const wallet: WalletOption = {
  key: "std:Phantom:0",
  name: "Phantom",
  signIn: () => Promise.reject(new Error("not used")),
};

const privyOn: PrivyConfig = { enabled: true, signupsOpen: true };
const freeOpen = {
  phase: "open" as const,
  signInStartsAt: "2026-10-22T12:00:00.000Z",
  signInEndsAt: "2026-10-22T18:00:00.000Z",
  accessEndsAt: "2026-10-23T18:00:00.000Z",
};

function panel(
  overrides: Partial<Parameters<typeof SignInPanel>[0]> = {},
): Parameters<typeof SignInPanel>[0] {
  return {
    wallets: [],
    searching: false,
    busy: null,
    error: null,
    privy: null,
    free: null,
    onConnect: () => {},
    onEmail: () => {},
    onGuest: () => {},
    ...overrides,
  };
}

describe("signed-out landing", () => {
  it("shows the product and a labeled example before any feed answer", () => {
    const html = renderToStaticMarkup(
      <LandingShowcase now={now} best={{ data: null, error: null }} latest={{ data: null, error: null }} />,
    );
    expect(html).toContain("What an alert looks like");
    expect(html).toContain("Made-up coin");
    expect(html).toContain("Not a live alert");
    expect(html).toContain("Example Coin");
    expect(html).not.toContain("stat-score");
    expect(html).not.toContain("KOL bundled");
    expect(html).toContain("Checking the last 24 hours for a real alert");
    expect(html).not.toContain("trade.padre.gg");
    expect(html).not.toContain("https://x.com/example");
    expect(html).not.toContain("https://example.com");
  });

  it("keeps the example when a real best alert is shown beside it", () => {
    const html = renderToStaticMarkup(
      <LandingShowcase
        now={now}
        best={{ data: { match: namedCard("LIVECOIN"), windowHours: 24 }, error: null }}
        latest={{ data: { matches: [] }, error: null }}
      />,
    );
    expect(html).toContain("Example Coin");
    expect(html).toContain("Made-up coin");
    expect(html).toContain("Best model alert of the last 24 hours");
    expect(html).toContain("LIVECOIN");
    expect(html).not.toContain("The card above is an example.");
  });

  it("labels a latest-alert fallback as a real delayed alert", () => {
    const html = renderToStaticMarkup(
      <LandingShowcase
        now={now}
        best={{ data: { match: null, windowHours: 24 }, error: null }}
        latest={{ data: { matches: [namedCard("LATEST")], delayMinutes: 5 }, error: null }}
      />,
    );
    expect(html).toContain("Latest alert, shown 5 minutes late");
    expect(html).toContain("LATEST");
    expect(html).toContain("Example Coin");
  });

  it("says the feed is empty without dropping the example", () => {
    const html = renderToStaticMarkup(
      <LandingShowcase
        now={now}
        best={{ data: { match: null, windowHours: 24 }, error: null }}
        latest={{ data: { matches: [] }, error: null }}
      />,
    );
    expect(html).toContain("Nothing to show from the guest feed right now");
    expect(html).toContain("The card above is an example.");
    expect(html).not.toContain("Best model alert of the last");
  });

  it("says the feed didn't answer, and still shows the example", () => {
    const html = renderToStaticMarkup(
      <LandingShowcase
        now={now}
        best={{ data: null, error: new Error("down") }}
        latest={{ data: null, error: null }}
      />,
    );
    expect(html).toContain("The live feed didn");
    expect(html).toContain("not a recent alert");
    expect(html).toContain("Example Coin");
  });

  it("waits for the latest alert when the best window is empty", () => {
    const html = renderToStaticMarkup(
      <LandingShowcase
        now={now}
        best={{ data: { match: null, windowHours: 24 }, error: null }}
        latest={{ data: null, error: null }}
      />,
    );
    expect(html).toContain("Checking the latest alert");
    expect(html).not.toContain("Nothing to show");
  });
});

describe("sign-in panel", () => {
  it("explains the wallet signature and looks for wallets", () => {
    const html = renderToStaticMarkup(<SignInPanel {...panel({ searching: true })} />);
    expect(html).toContain("Solana wallet");
    expect(html).toContain("sends no transaction");
    expect(html).toContain("nothing is sent on-chain");
    expect(html).toContain("Looking for wallets in this browser");
    expect(html).not.toContain("No Solana wallet");
  });

  it("tells you what to install when no wallet turns up", () => {
    const html = renderToStaticMarkup(<SignInPanel {...panel()} />);
    expect(html).toContain("No Solana wallet in this browser.");
    expect(html).toContain("https://phantom.app");
    expect(html).toContain("https://solflare.com");
    expect(html).toContain("then reload");
  });

  it("names each wallet and shows a failed sign-in", () => {
    const html = renderToStaticMarkup(
      <SignInPanel
        {...panel({
          wallets: [wallet],
          error: "You cancelled in the wallet. Press the wallet again when you're ready to sign.",
        })}
      />,
    );
    expect(html).toContain("Phantom");
    expect(html).toContain('role="alert"');
    expect(html).toContain("You cancelled in the wallet");
  });

  it("disables the choices while a wallet prompt is open", () => {
    const html = renderToStaticMarkup(
      <SignInPanel {...panel({ wallets: [wallet], busy: wallet.key, privy: privyOn })} />,
    );
    expect(html).toContain("Waiting for wallet…");
    expect(html).toContain("disabled");
    expect(html).toContain("aria-busy");
  });

  it("says what email sign-in is, including when sign-ups are full", () => {
    const open = renderToStaticMarkup(<SignInPanel {...panel({ privy: privyOn })} />);
    expect(open).toContain("Email, Google, or X");
    expect(open).toContain("Sign in with email, Google or X");
    expect(open).toContain("separate account");
    expect(open).toContain("no free start");

    const closed = renderToStaticMarkup(
      <SignInPanel {...panel({ privy: { enabled: true, signupsOpen: false } })} />,
    );
    expect(closed).toContain("New email sign-ups are full");
    expect(closed).not.toContain("no free start");
  });

  it("shows free access and the guest limits", () => {
    const html = renderToStaticMarkup(<SignInPanel {...panel({ free: freeOpen })} />);
    expect(html).toContain("Free access is open: sign in before");
    expect(html).toContain("to use everything until");
    expect(html).toContain("Continue as guest");
    expect(html).toContain("5 minutes");
    expect(html).toContain("burn $ASDFASDFA");
    expect(html).toContain("Show QR code");
  });

  it("hides the guest path when it is not offered", () => {
    const html = renderToStaticMarkup(<SignInPanel {...panel({ onGuest: undefined })} />);
    expect(html).not.toContain("Continue as guest");
  });
});

describe("SignIn page", () => {
  it("renders the landing, the example, and the wallet search together", () => {
    const html = renderToStaticMarkup(<SignIn onSignedIn={() => {}} onGuest={() => {}} />);
    expect(html).toContain("A trading terminal for Solana tokens.");
    expect(html).toContain("Screen a Solana token");
    expect(html).toContain("Burn it for access. A separate burn buys Burn Credits");
    expect(html).toContain("250 largest holders, and a wallet an admin grants");
    expect(html).toContain("no TrenchScanner fee");
    expect(html).not.toContain("Pump.fun alerts");
    expect(html).not.toContain("not a live call");
    expect(html).toContain("Example Coin");
    expect(html).toContain("Made-up coin");
    expect(html).toContain("Looking for wallets in this browser");
    expect(html).toContain("Continue as guest");
  });
});
