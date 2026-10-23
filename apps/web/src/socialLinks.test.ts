import { describe, expect, it } from "vitest";
import { socialLinks } from "./components/AlertCard";

describe("socialLinks", () => {
  it("gives a pill for each link the coin has, X first", () => {
    const links = socialLinks({ twitterUrl: "https://x.com/coin", websiteUrl: "https://coin.fun/" });
    expect(links.map((l) => [l.key, l.url])).toEqual([
      ["x", "https://x.com/coin"],
      ["web", "https://coin.fun/"],
    ]);
    expect(socialLinks({ twitterUrl: null, websiteUrl: "https://coin.fun" }).map((l) => l.key)).toEqual([
      "web",
    ]);
  });

  it("puts Telegram between X and the website when the source has it", () => {
    const links = socialLinks({
      twitterUrl: "https://x.com/coin",
      telegramUrl: "https://t.me/coin",
      websiteUrl: "https://coin.fun/",
    });
    expect(links.map((l) => l.key)).toEqual(["x", "tg", "web"]);
    expect(socialLinks({ telegramUrl: "tg://resolve?domain=coin" })).toEqual([]);
  });

  it("shows nothing for a missing, unreadable or non-https link", () => {
    expect(socialLinks({})).toEqual([]);
    expect(socialLinks({ twitterUrl: "", websiteUrl: "not a url" })).toEqual([]);
    expect(socialLinks({ twitterUrl: "javascript:alert(1)", websiteUrl: "http://coin.fun" })).toEqual([]);
  });
});
