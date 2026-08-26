import { describe, expect, it } from "vitest";
import { redactUrl } from "./httpClient.js";

describe("redactUrl", () => {
  it("redacts Helius's own api-key query param", () => {
    const redacted = redactUrl("https://mainnet.helius-rpc.com/?api-key=super-secret-value");
    expect(redacted).not.toContain("super-secret-value");
    expect(redacted).toContain("api-key=REDACTED");
  });

  it("redacts other common secret param spellings", () => {
    expect(redactUrl("https://example.com/x?apikey=abc")).not.toContain("abc");
    expect(redactUrl("https://example.com/x?api_key=abc")).not.toContain("abc");
    expect(redactUrl("https://example.com/x?key=abc")).not.toContain("abc");
    expect(redactUrl("https://example.com/x?token=abc")).not.toContain("abc");
    expect(redactUrl("https://example.com/x?secret=abc")).not.toContain("abc");
  });

  it("leaves non-sensitive query params and the rest of the URL untouched", () => {
    const redacted = redactUrl("https://api.dexscreener.com/tokens/v1/solana/abc,def?foo=bar");
    expect(redacted).toContain("foo=bar");
    expect(redacted).toContain("/tokens/v1/solana/abc,def");
  });

  it("leaves a URL with no query params entirely unchanged", () => {
    const url = "https://api.rugcheck.xyz/v1/tokens/abc123/report";
    expect(redactUrl(url)).toBe(url);
  });

  it("falls back to returning the input unchanged if it isn't a parseable absolute URL", () => {
    expect(redactUrl("not a url at all")).toBe("not a url at all");
  });
});
