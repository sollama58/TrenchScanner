import { describe, expect, it } from "vitest";
import { walletTag } from "./walletTag.js";

describe("walletTag", () => {
  it("names a wallet by 12 hex characters of its sha256, never the address", () => {
    const tag = walletTag("5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9");
    expect(tag).toMatch(/^[0-9a-f]{12}$/);
    expect(tag).toBe(walletTag("5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9"));
    expect(tag).not.toBe(walletTag("4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE"));
  });
});
