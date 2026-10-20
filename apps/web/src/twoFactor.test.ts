import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import {
  askBefore,
  changeBlocked,
  clearPasses,
  promptRequest,
  twoFactorNeeded,
  TwoFactorCancelled,
  withTwoFactor,
} from "./twoFactor";

const needs = (action: string, extra: object = { totp: true, passkey: false }) =>
  new ApiError(403, "Two-factor check needed", { error: "x", twoFactor: { action, ...extra } });

afterEach(() => {
  clearPasses();
  promptRequest()?.done(false);
  vi.unstubAllGlobals();
});

describe("twoFactorNeeded", () => {
  it("reads the API's ask, and nothing else", () => {
    expect(twoFactorNeeded(needs("buy"))).toEqual({ action: "buy", hint: { totp: true, passkey: false } });
    expect(twoFactorNeeded(needs("manage", {}))).toEqual({ action: "manage", hint: undefined });
    expect(twoFactorNeeded(new ApiError(403, "Pro Mode only", { error: "Pro Mode only" }))).toBeNull();
    expect(twoFactorNeeded(new ApiError(401, "x", { twoFactor: { action: "buy" } }))).toBeNull();
    expect(twoFactorNeeded(new Error("x"))).toBeNull();
  });
});

describe("changeBlocked", () => {
  it("reads why the API refused a two-factor change, and nothing else", () => {
    const refused = (code: string) => new ApiError(403, "x", { error: "x", code });
    expect(changeBlocked(refused("paired_phone"))).toBe("paired_phone");
    expect(changeBlocked(refused("sign_in_again"))).toBe("sign_in_again");
    expect(changeBlocked(refused("something_else"))).toBeNull();
    expect(changeBlocked(needs("manage"))).toBeNull();
    expect(changeBlocked(new ApiError(401, "x", { code: "sign_in_again" }))).toBeNull();
  });

  it("is never prompted for: the change can't pass with a code", async () => {
    const call = vi.fn(async () => {
      throw new ApiError(403, "x", { error: "x", code: "paired_phone" });
    });
    await expect(withTwoFactor(call)).rejects.toBeInstanceOf(ApiError);
    expect(call).toHaveBeenCalledTimes(1);
    expect(promptRequest()).toBeNull();
  });
});

describe("withTwoFactor", () => {
  it("prompts when the API asks, then retries once with the pass", async () => {
    const fetchMock = vi.fn(async () => Response.json({ pass: "PASS-1", ttlSeconds: 300 }));
    vi.stubGlobal("fetch", fetchMock);
    const call = vi
      .fn<(h: Record<string, string>) => Promise<string>>()
      .mockRejectedValueOnce(needs("buy"))
      .mockResolvedValueOnce("built");
    const result = withTwoFactor(call);
    await vi.waitFor(() => expect(promptRequest()).not.toBeNull());
    const req = promptRequest()!;
    expect(req.hint).toEqual({ totp: true, passkey: false });
    await req.submit({ code: "123456" });
    req.done(true);
    expect(await result).toBe("built");
    expect(call).toHaveBeenNthCalledWith(1, {});
    expect(call).toHaveBeenNthCalledWith(2, { "x-ts-2fa": "PASS-1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/auth\/2fa\/verify$/);
    expect(JSON.parse(String(init.body))).toEqual({ action: "buy", code: "123456" });
  });

  it("stops when the user closes the prompt", async () => {
    const call = vi.fn(async () => {
      throw needs("sell");
    });
    const result = withTwoFactor(call);
    await vi.waitFor(() => expect(promptRequest()).not.toBeNull());
    promptRequest()!.done(false);
    await expect(result).rejects.toBeInstanceOf(TwoFactorCancelled);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("passes other errors straight through", async () => {
    await expect(withTwoFactor(async () => Promise.reject(new ApiError(500, "boom", null)))).rejects.toThrow(
      "boom",
    );
    expect(promptRequest()).toBeNull();
  });
});

describe("askBefore", () => {
  const state = (enabled: boolean, actions: string[]) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ enabled, totp: true, passkeys: [], actions })),
    );

  it("goes ahead without asking while two-factor is off, or for a burn the user didn't pick", async () => {
    state(false, ["burn"]);
    await expect(askBefore("export")).resolves.toBeUndefined();
    state(true, ["sell"]);
    await expect(askBefore("burn")).resolves.toBeUndefined();
    expect(promptRequest()).toBeNull();
  });

  it("asks before exports always, and burns when picked, reading the choices fresh", async () => {
    state(true, []);
    const exporting = askBefore("export");
    await vi.waitFor(() => expect(promptRequest()).not.toBeNull());
    promptRequest()!.done(false);
    await expect(exporting).rejects.toBeInstanceOf(TwoFactorCancelled);
    state(true, ["burn"]);
    const burning = askBefore("burn");
    await vi.waitFor(() => expect(promptRequest()).not.toBeNull());
    promptRequest()!.done(false);
    await expect(burning).rejects.toBeInstanceOf(TwoFactorCancelled);
  });

  it("lets an export go ahead when the settings can't be read, but not a burn (user decision 2026-10-20)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(askBefore("export")).resolves.toBeUndefined();
    await expect(askBefore("burn")).rejects.toThrow();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "down" }, { status: 503 })),
    );
    await expect(askBefore("export")).resolves.toBeUndefined();
    expect(promptRequest()).toBeNull();
  });
});
