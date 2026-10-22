import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ago } from "../format";
import { DEFAULT_APPEARANCE } from "../appearance";
import { shortAge } from "../scope";
import { scopeSampleCard } from "../scopeSample";
import { DEFAULT_SCOPE_SETTINGS } from "../scopeSettings";
import { tileMode } from "../tileTone";
import type { Card } from "../api";
import { AlertCard } from "./AlertCard";
import { ScopeRow } from "./ScopeBoard";

vi.mock("../appearance", async () => {
  const actual = await vi.importActual<typeof import("../appearance")>("../appearance");
  return { ...actual, useAppearance: () => actual.DEFAULT_APPEARANCE };
});

vi.mock("../proTrade", async () => {
  const actual = await vi.importActual<typeof import("../proTrade")>("../proTrade");
  return { ...actual, useTradeSettings: () => actual.DEFAULT_TRADE_SETTINGS };
});

const now = Date.parse("2026-10-22T00:00:00.000Z");

function chipCount(html: string): number {
  return html.match(/age-chip/g)?.length ?? 0;
}

describe("alert age chip", () => {
  it("uses the same chip for a filter alert and a model alert on a card", () => {
    const filter = scopeSampleCard(now);
    filter.curated = null;
    const filterHtml = renderToStaticMarkup(<AlertCard card={filter} now={now} />);
    expect(chipCount(filterHtml)).toBe(1);
    expect(filterHtml).toContain(`class="when age-chip"`);
    expect(filterHtml).toContain(ago(filter.matchedAt, now));

    const model = scopeSampleCard(now);
    (model as Card).kind = "curated";
    model.filter = null;
    const modelHtml = renderToStaticMarkup(<AlertCard card={model} now={now} />);
    expect(chipCount(modelHtml)).toBe(1);
    expect(modelHtml).toContain(`class="when age-chip"`);
    expect(modelHtml).toContain(ago(model.matchedAt, now));
  });

  it("puts the same chip under the figures of a Scope row and a Stream row, with the search by the ticker", () => {
    const display = DEFAULT_SCOPE_SETTINGS.display;
    const tiles = tileMode(DEFAULT_APPEARANCE);
    const filter = scopeSampleCard(now);
    const filterHtml = renderToStaticMarkup(
      <ScopeRow card={filter} now={now} display={display} tiles={tiles} preview />,
    );
    expect(filterHtml).toContain("scope-ticker");
    expect(chipCount(filterHtml)).toBe(1);
    expect(filterHtml).toContain("scope-age age-chip");
    expect(filterHtml).toContain(shortAge(42_000));
    // Under the figures beside the Dex pill, and the search beside the ticker (user ask 2026-10-22).
    const filterTicker = filterHtml.slice(
      filterHtml.indexOf("scope-ticker"),
      filterHtml.indexOf("scope-name"),
    );
    expect(filterTicker).not.toContain("age-chip");
    expect(filterTicker).toContain("scope-search");
    expect(filterHtml.slice(filterHtml.indexOf("scope-fig-pills"))).toContain("age-chip");

    const stream = scopeSampleCard(now);
    (stream as Card).kind = "stream";
    stream.filter = null;
    stream.curated = null;
    const streamHtml = renderToStaticMarkup(
      <ScopeRow card={stream} now={now} display={display} tiles={tiles} preview />,
    );
    expect(chipCount(streamHtml)).toBe(1);
    expect(streamHtml).toContain("scope-age age-chip");
    expect(streamHtml).toContain(shortAge(42_000));
  });
});
