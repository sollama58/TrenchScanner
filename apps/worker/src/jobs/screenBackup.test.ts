import { describe, expect, it, vi } from "vitest";
import type { HeliusClient, MayhemModeResult } from "@trenchscanner/core";
import { chainBackupUrl, chainBackupUrls, REST_MS, ScreenBackup, screenBackupFor } from "./screenBackup.js";

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

  it("asks the next endpoint for what the one before it couldn't answer, resting the one that answered nothing", async () => {
    const now = 0;
    const down = reader(() => ({ status: "failed" }));
    const up = reader(() => ({ status: "found", isMayhemMode: true }));
    const backup = new ScreenBackup([down.client, up.client], () => now);
    expect([...(await backup.mayhem(["a", "b"]))]).toEqual([
      ["a", true],
      ["b", true],
    ]);
    await backup.mayhem(["c"]);
    expect(down.getMayhemModeBatch).toHaveBeenCalledTimes(1);
    expect(up.getMayhemModeBatch.mock.calls.map(([c]) => c)).toEqual([["a", "b"], ["c"]]);
    expect(backup.takeStats()).toEqual({ asked: 3, found: 3, rested: 1 });
  });

  it("doesn't rest an endpoint that answered a mint isn't on-chain yet", async () => {
    const now = 0;
    const r = reader(() => ({ status: "failed", mintPending: true }));
    const backup = new ScreenBackup(r.client, () => now);
    expect((await backup.mayhem(["fresh"])).size).toBe(0);
    await backup.mayhem(["fresh"]);
    expect(r.getMayhemModeBatch).toHaveBeenCalledTimes(2);
  });

  // 2026-11-21: neither public node answers getTokenLargestAccounts (publicnode wants a personal
  // token, mainnet-beta 429s that method), ~30,000 refused calls a day through the Helius outage.
  it("asks the public nodes for Mayhem flags but never for holders", async () => {
    const holders = { holders: [], top10Pct: 10 } as never;
    const built: {
      url: string;
      getMayhemModeBatch: ReturnType<typeof vi.fn>;
      getLargestHoldersBatch: ReturnType<typeof vi.fn>;
    }[] = [];
    const backup = screenBackupFor(
      { CHAIN_BACKUP_RPC_URLS: "https://paid.example/k", SOLANA_RPC_URL: "", TRADING_BACKUP_RPC_URL: "" },
      (url) => {
        const r = {
          url,
          getMayhemModeBatch: vi.fn(
            async (mints: string[]) =>
              new Map(
                mints.map((m) => [m, { status: "failed", mintPending: true } as MayhemModeResult] as const),
              ),
          ),
          getLargestHoldersBatch: vi.fn(async () => new Map()),
        };
        built.push(r);
        return r as unknown as HeliusClient;
      },
    );
    expect(built.map((b) => b.url)).toEqual([
      "https://paid.example/k",
      "https://solana-rpc.publicnode.com",
      "https://api.mainnet-beta.solana.com",
    ]);
    await backup.mayhem(["a"]);
    expect(built.map((b) => b.getMayhemModeBatch.mock.calls.length)).toEqual([1, 1, 1]);
    built[0]!.getLargestHoldersBatch.mockResolvedValueOnce(new Map([["b", { status: "found", holders }]]));
    expect((await backup.holders(["b"])).get("b")).toBe(holders);
    await backup.holders(["c"]);
    expect(built.map((b) => b.getLargestHoldersBatch.mock.calls.length)).toEqual([2, 0, 0]);
  });

  it("answers no holders, without asking, when only public nodes are configured", async () => {
    const getLargestHoldersBatch = vi.fn();
    const backup = screenBackupFor(
      { CHAIN_BACKUP_RPC_URLS: "", SOLANA_RPC_URL: "", TRADING_BACKUP_RPC_URL: "" },
      () => ({ getMayhemModeBatch: vi.fn(), getLargestHoldersBatch }) as unknown as HeliusClient,
    );
    expect((await backup.holders(["a"])).size).toBe(0);
    expect(getLargestHoldersBatch).not.toHaveBeenCalled();
    expect(backup.takeStats()).toEqual({ asked: 0, found: 0, rested: 0 });
  });

  it("lists every configured endpoint, then the public nodes, without Helius", () => {
    expect(
      chainBackupUrls({
        CHAIN_BACKUP_RPC_URLS: "https://paid.example/k, https://mainnet.helius-rpc.com/?api-key=x",
        SOLANA_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=x",
        TRADING_BACKUP_RPC_URL: "https://paid.example/k",
      }),
    ).toEqual([
      "https://paid.example/k",
      "https://solana-rpc.publicnode.com",
      "https://api.mainnet-beta.solana.com",
    ]);
  });

  it("uses the first paid backup URL, else the public node", () => {
    expect(chainBackupUrl({ CHAIN_BACKUP_RPC_URLS: " , https://paid.example/k, https://b" })).toBe(
      "https://paid.example/k",
    );
    expect(chainBackupUrl({ CHAIN_BACKUP_RPC_URLS: "" })).toBe("https://api.mainnet-beta.solana.com");
  });
});
