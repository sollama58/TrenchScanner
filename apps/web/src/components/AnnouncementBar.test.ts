import { describe, expect, it } from "vitest";
import { linkify } from "./AnnouncementBar";

describe("linkify", () => {
  it("leaves plain text alone", () => {
    expect(linkify("Maintenance at 22:00 UTC")).toEqual(["Maintenance at 22:00 UTC"]);
  });

  it("splits out links without their trailing punctuation", () => {
    expect(linkify("Read https://example.com/notes. Then (see http://a.io/x)")).toEqual([
      "Read ",
      { href: "https://example.com/notes" },
      ". Then (see ",
      { href: "http://a.io/x" },
      ")",
    ]);
  });

  it("does not link other schemes", () => {
    expect(linkify("javascript:alert(1)")).toEqual(["javascript:alert(1)"]);
  });
});
