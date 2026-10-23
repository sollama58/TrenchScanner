// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { describe, expect, it, vi } from "vitest";
import { prisma } from "@trenchscanner/core";
import { rememberDexInfo, scheduleDexInfo } from "./scanJob.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe.skipIf(!dbAvailable)("scheduleDexInfo", () => {
  it("runs one orders read at a time and leaves mints queued meanwhile for the next", async () => {
    let release!: (mints: string[]) => void;
    const communityTakeoverMints = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          release = resolve;
        }),
    );
    const readTokenInfoOrders = vi.fn(async () => []);
    const dex = { communityTakeoverMints, readTokenInfoOrders };

    rememberDexInfo("dexinfo-test-a");
    const first = scheduleDexInfo(dex);
    expect(first).not.toBeNull();
    // A later call in the same cycle while the first is still out starts nothing.
    rememberDexInfo("dexinfo-test-b");
    expect(scheduleDexInfo(dex)).toBeNull();
    expect(communityTakeoverMints).toHaveBeenCalledTimes(1);

    release([]);
    await first;
    // The read is done: the mint queued meanwhile goes out on the next call.
    const next = scheduleDexInfo(dex);
    expect(next).not.toBeNull();
    expect(communityTakeoverMints).toHaveBeenCalledTimes(2);
    release([]);
    await next;
  });
});
