import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveStamp } from "./Freshness";

describe("LiveStamp", () => {
  const last = Date.now() - 16_000;
  const next = Date.now() + 45_000;

  it("says the age and the next update while a re-read is scheduled", () => {
    const html = renderToStaticMarkup(<LiveStamp last={last} next={next} />);
    expect(html).toMatch(/s ago · Next update in /);
    expect(html).not.toMatch(/>Live</);
    expect(html.toLowerCase()).not.toMatch(/>[^<]*live/);
  });

  it("says exactly Live when the stream is pushing and no re-read is scheduled", () => {
    const html = renderToStaticMarkup(<LiveStamp last={last} next={null} live />);
    expect(html).toMatch(/>Live</);
    expect(html).not.toMatch(/ago|Next update|Updating|Checking again/);
  });

  it("does not call a scheduled re-read live", () => {
    const html = renderToStaticMarkup(<LiveStamp last={last} next={next} live />);
    expect(html).toMatch(/s ago · Next update in /);
    expect(html).not.toMatch(/>Live</);
  });
});
