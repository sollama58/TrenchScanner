// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KNOWN_EXCHANGE_WALLETS, loadEnv, prisma, type Env } from "@trenchscanner/core";
import { FUNDER_WORST, TRACE_HOPS, traceFunders, traceNote, type FunderTrace } from "./chain.js";

/** Real ed25519 public keys: a funder must be on the curve for the trace to go on from it. */
const [A, B, C, D, E, F] = [
  "2cER2peZXLpnJAaStnoDHmXAEmgzkEPMU2f1gbpT5ABv",
  "8faJMzdGivifdQUjtLuWVfmHLL5bXb3Ra8yrLFvpiFkS",
  "EACocApB8v6vmMme2jzxQKgjeG2W94EWUc2TWd9NvbHW",
  "42m2gj2LK29RHtmZLmXaRgj46azibjeAmW2TZYSD7p4h",
  "59t1Pby9UKkNP8mJ6BsYCnLR1L8c4ZpiQwFuU3sioUdx",
  "9fZTZQu5NQuTSKJPMWqAK21yDBSgiVN9XU2V76fBnAFj",
] as const;
const EXCHANGE = [...KNOWN_EXCHANGE_WALLETS.keys()][0]!;
const PROGRAM = "AsyTraceProgram" + "1".repeat(28);
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe("traceNote", () => {
  const t = (path: string[], stop: FunderTrace["stop"]): FunderTrace => ({ path, stop, asked: 0 });
  it("says how far the trail went and why it stopped", () => {
    expect(traceNote(t([A, B, EXCHANGE], "exchange"), "Binance")).toBe(
      "Traced 2 funders back. The trail ends at Binance, an exchange or service wallet that pays thousands of strangers.",
    );
    expect(traceNote(t([A], "origin"))).toBe(
      "No funder found: nothing paid it SOL before its first transactions.",
    );
    expect(traceNote(t([A, B], "origin"))).toMatch(/^Traced 1 funder back\. 8faJ…iFkS is where it starts/);
    expect(traceNote(t([A, B], "limit"))).toContain(`Stopped after ${TRACE_HOPS} hops`);
  });
});

describe.skipIf(!dbAvailable)("traceFunders", () => {
  const now = Date.UTC(2026, 9, 25, 12, 0);
  const env: Env = dbAvailable
    ? { ...loadEnv(), ASYL_USER_DAILY_CREDITS: 3000, ASYL_DAILY_CREDITS: 150_000 }
    : (undefined as never);
  const ids = [A, B, C, D, E, F];
  const users = ["asyl-trace-a", "asyl-trace-b", "asyl-trace-c"];
  const cleanup = async () => {
    await prisma.walletFunder.deleteMany({ where: { wallet: { in: ids } } });
    await prisma.asylCreditUse.deleteMany({ where: { userId: { in: users } } });
  };
  beforeAll(cleanup);
  afterAll(cleanup);

  /** A chain where A ← B ← C ← an exchange, D was paid by a program, E and F paid each other. */
  const funderOf: Record<string, string | null> = {
    [A]: B,
    [B]: C,
    [C]: EXCHANGE,
    [D]: PROGRAM,
    [E]: F,
    [F]: E,
  };
  const asked: string[] = [];
  const helius = {
    async getFundersBatch(wallets: string[]) {
      asked.push(...wallets);
      return new Map(
        wallets.map((w) => [
          w,
          funderOf[w]
            ? {
                status: "found" as const,
                funder: funderOf[w]!,
                amountSol: 1.5,
                fundedAt: new Date(now - 86_400_000),
                lastActivityAt: new Date(now),
              }
            : { status: "none" as const, lastActivityAt: new Date(now) },
        ]),
      );
    },
  };

  it("follows the funders to an exchange, and the next trace reads nothing", async () => {
    const first = await traceFunders(env, helius as never, users[0]!, A, now);
    expect(first).toMatchObject({
      value: { path: [A, B, C, EXCHANGE], stop: "exchange", asked: 3 },
      cached: false,
    });
    expect(asked).toEqual([A, B, C]);
    const again = await traceFunders(env, helius as never, users[1]!, B, now);
    expect(again).toMatchObject({
      value: { path: [B, C, EXCHANGE], stop: "exchange", asked: 0 },
      cached: true,
    });
    expect(asked).toHaveLength(3);
  });

  it("stops at a program account and at a loop", async () => {
    expect(await traceFunders(env, helius as never, users[0]!, D, now)).toMatchObject({
      value: { path: [D, PROGRAM], stop: "unreadable" },
    });
    expect(await traceFunders(env, helius as never, users[0]!, E, now)).toMatchObject({
      value: { path: [E, F], stop: "loop" },
    });
  });

  it("stops where the day's allowance no longer covers the next read", async () => {
    await prisma.walletFunder.deleteMany({ where: { wallet: { in: ids } } });
    const tight: Env = { ...env, ASYL_USER_DAILY_CREDITS: FUNDER_WORST * 2 + 1 };
    expect(await traceFunders(tight, helius as never, users[2]!, A, now)).toMatchObject({
      value: { path: [A, B, C], stop: "allowance", asked: 2 },
    });
  });
});
