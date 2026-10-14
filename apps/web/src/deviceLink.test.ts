import { afterEach, describe, expect, it, vi } from "vitest";
import type { User } from "./api";
import {
  buildLinkUrl,
  currentSignIn,
  describeDevice,
  isLinkHash,
  mayReplaceSignIn,
  parseLinkHash,
  replaceSignInQuestion,
} from "./deviceLink";

const CODE = "a".repeat(32) + "0123456789abcdef".repeat(2);

describe("pairing links", () => {
  it("puts the code in the fragment, never the query string", () => {
    const url = buildLinkUrl("https://trenchscanner.app", CODE);
    expect(url).toBe(`https://trenchscanner.app/#link=${CODE}`);
    expect(new URL(url).search).toBe("");
  });

  it("reads back the code it built", () => {
    expect(parseLinkHash(new URL(buildLinkUrl("https://x.test", CODE)).hash)).toBe(CODE);
    expect(parseLinkHash(`link=${CODE.toUpperCase()}`)).toBe(CODE);
  });

  it("treats a half-copied or foreign code as a pairing link with no code", () => {
    expect(isLinkHash("#link=abc")).toBe(true);
    expect(parseLinkHash("#link=abc")).toBeNull();
    expect(parseLinkHash(`#link=${CODE}x`)).toBeNull();
    expect(parseLinkHash("#link=")).toBeNull();
  });

  it("leaves tab hashes alone", () => {
    for (const h of ["", "#", "#settings", "#model", "#linked"]) {
      expect(isLinkHash(h)).toBe(false);
      expect(parseLinkHash(h)).toBeNull();
    }
  });
});

describe("a pairing link over an existing sign-in", () => {
  const me: User = { id: "u1", walletAddress: "So11111111111111111111111111111111111111112", isAdmin: false };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("goes ahead without asking when nobody is signed in", () => {
    const ask = vi.fn(() => false);
    expect(mayReplaceSignIn(null, ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks before replacing someone's sign-in, naming their wallet", () => {
    const ask = vi.fn(() => true);
    expect(mayReplaceSignIn(me, ask)).toBe(true);
    expect(ask).toHaveBeenCalledOnce();
    expect(ask.mock.calls[0]).toEqual([replaceSignInQuestion(me)]);
    expect(replaceSignInQuestion(me)).toContain("So11…1112");
    expect(replaceSignInQuestion(me)).toMatch(/Replace your current sign-in/);
  });

  it("keeps the current sign-in when the reader says no", () => {
    expect(mayReplaceSignIn(me, () => false)).toBe(false);
  });

  it("reads who is signed in from /auth/me, and a 401 as nobody", async () => {
    const reply = (status: number, body: unknown) =>
      vi.fn(async () => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", reply(200, me));
    expect(await currentSignIn()).toEqual(me);
    vi.stubGlobal("fetch", reply(401, { error: "Not signed in" }));
    expect(await currentSignIn()).toBeNull();
  });
});

describe("describeDevice", () => {
  it("names common phones", () => {
    expect(
      describeDevice(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("iPhone · Safari");
    expect(
      describeDevice(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("iPhone · Chrome");
    expect(
      describeDevice(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36",
      ),
    ).toBe("Android · Chrome");
  });

  it("says so when it doesn't know", () => {
    expect(describeDevice(null)).toBe("Unknown device");
    expect(describeDevice("curl/8.0")).toBe("Unknown device");
  });
});
