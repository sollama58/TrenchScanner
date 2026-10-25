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

  it("says Live with the list's age while it is live", () => {
    const html = renderToStaticMarkup(
      <LiveStamp last={last} next={next} live liveUntil={Date.now() + 60_000} />,
    );
    expect(html).toMatch(/>Live · updated 1\ds ago</);
    expect(html).not.toMatch(/Next update|Updating|Checking again/);
  });

  it("drops Live and counts down once the list is past its next read", () => {
    const html = renderToStaticMarkup(<LiveStamp last={last} next={next} live liveUntil={last} />);
    expect(html).toMatch(/>Updated 1\ds ago · Next update in /);
    expect(html).not.toMatch(/>Live/);
  });
});
