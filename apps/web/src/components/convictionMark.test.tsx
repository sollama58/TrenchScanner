import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { scopeSampleCard } from "../scopeSample";
import { AboutDetails } from "./AboutDetails";
import { AlertCard } from "./AlertCard";

// Alert cards read appearance and trade settings through stores that have no server snapshot.
vi.mock("../appearance", async () => {
  const actual = await vi.importActual<typeof import("../appearance")>("../appearance");
  return { ...actual, useAppearance: () => actual.DEFAULT_APPEARANCE };
});

vi.mock("../proTrade", async () => {
  const actual = await vi.importActual<typeof import("../proTrade")>("../proTrade");
  return { ...actual, useTradeSettings: () => actual.DEFAULT_TRADE_SETTINGS };
});

/** The lightning-bolt icon path. The high-conviction mark must not use it. */
const BOLT_PATH = "M13 2L4 14h7l-1 8 9-12h-7z";

describe("high conviction mark", () => {
  it("shows an exclamation mark on a high-conviction card and in the glossary", () => {
    const now = Date.parse("2026-10-22T00:00:00.000Z");
    const html = renderToStaticMarkup(<AlertCard card={scopeSampleCard(now)} now={now} />);
    expect(html).toContain('aria-label="High conviction"');
    expect(html).toContain("pill-conviction");
    expect(html).toContain("❗");
    expect(html).not.toContain(BOLT_PATH);

    const about = renderToStaticMarkup(<AboutDetails targets={{ hitRate2xPct: 40, hitRate4xPct: 20 }} />);
    expect(about).toContain("High conviction");
    expect(about).toContain("❗");
    expect(about).toContain("exclamation mark");
    expect(about).not.toContain(BOLT_PATH);
  });

  it("stays off when the call is not high conviction", () => {
    const now = Date.parse("2026-10-22T00:00:00.000Z");
    const card = scopeSampleCard(now);
    if (card.curated) card.curated.tier = "standard";
    const html = renderToStaticMarkup(<AlertCard card={card} now={now} />);
    expect(html).not.toContain("pill-conviction");
    expect(html).not.toContain("❗");
  });
});
