import { describe, expect, it, vi } from "vitest";
import type { HeliusClient, MayhemModeResult } from "@trenchscanner/core";
import { chainBackupUrl, REST_MS, ScreenBackup } from "./screenBackup.js";

function reader(answer: (mint: string) => MayhemModeResult) {
  let inFlight = 0;
  let most = 0;
  const getMayhemModeBatch = vi.fn(async (mints: string[]) => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return new Map(mints.map((m) => [m, answer(m)] as const));
  });
  return {
    client: { getMayhemModeBatch, getLargestHoldersBatch: vi.fn() } as unknown as HeliusClient,
    getMayhemModeBatch,
    most: () => most,
  };
}

describe("ScreenBackup", () => {
  it("reads small batches, one call at a time, and at most 60 mints a call", async () => {
    const r = reader(() => ({ status: "found", isMayhemMode: false }));
    const backup = new ScreenBackup(r.client);
    const mints = Array.from({ length: 100 }, (_, i) => `m${i}`);
    const [a, b] = await Promise.all([backup.mayhem(mints), backup.mayhem(["x"])]);
    expect(a.size).toBe(60);
    expect(b.get("x")).toBe(false);
    expect(r.getMayhemModeBatch.mock.calls.map(([c]) => c.length)).toEqual([20, 20, 20, 1]);
    expect(r.most()).toBe(1);
  });

  it("rests after a batch it answered nothing for (its own 429), and leaves the mints unverified", async () => {
    let now = 0;
    const r = reader(() => ({ status: "failed" }));
    const backup = new ScreenBackup(r.client, () => now);
    expect((await backup.mayhem(Array.from({ length: 40 }, (_, i) => `m${i}`))).size).toBe(0);
    expect(r.getMayhemModeBatch).toHaveBeenCalledTimes(1);
    await backup.mayhem(["y"]);
    expect(r.getMayhemModeBatch).toHaveBeenCalledTimes(1);
    now += REST_MS;
    await backup.mayhem(["y"]);
    expect(r.getMayhemModeBatch).toHaveBeenCalledTimes(2);
    expect(backup.takeStats()).toEqual({ asked: 21, found: 0, rested: 2 });
  });

  it("uses the first paid backup URL, else the public node", () => {
    expect(chainBackupUrl({ CHAIN_BACKUP_RPC_URLS: " , https://paid.example/k, https://b" })).toBe(
      "https://paid.example/k",
    );
    expect(chainBackupUrl({ CHAIN_BACKUP_RPC_URLS: "" })).toBe("https://api.mainnet-beta.solana.com");
  });
});
