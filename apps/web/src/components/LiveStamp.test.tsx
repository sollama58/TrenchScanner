import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveStamp } from "./Freshness";

describe("LiveStamp", () => {
  const last = Date.now() - 16_000;
  const next = Date.now() + 45_000;

  it("says the age and the next update while shares aren't moving live", () => {
    const html = renderToStaticMarkup(<LiveStamp last={last} next={next} />);
    expect(html).toMatch(/s ago · Next update in /);
    expect(html).not.toContain("Live");
  });

  it("keeps the age and the countdown while the trades feed moves the shares", () => {
    const html = renderToStaticMarkup(<LiveStamp last={last} next={next} live />);
    expect(html).toMatch(/Live · /);
    expect(html).toMatch(/s ago · Next update in /);
  });
});
