// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { randomBytes } from "node:crypto";
import bs58 from "bs58";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, type Env } from "@trenchscanner/core";
import { checkSecondFactor, resetTwoFactorFailuresForTests, sealSecret, totpCode } from "./twoFactor.js";

const env = { JWT_SECRET: "c".repeat(64) } as Env;
const secret = randomBytes(20);
let userId: string;

/** A code that is wrong now: none of the three steps matchTotp accepts. */
function wrongCode(): string {
  const step = Math.floor(Date.now() / 30_000);
  const near = new Set([step - 1, step, step + 1].map((s) => totpCode(secret, s)));
  for (let n = 0; ; n++) {
    const code = String(n).padStart(6, "0");
    if (!near.has(code)) return code;
  }
}

describe("two-factor wrong-code lockout", () => {
  beforeAll(async () => {
    const user = await prisma.user.create({ data: { walletAddress: bs58.encode(randomBytes(32)) } });
    userId = user.id;
    await prisma.twoFactorSettings.create({
      data: { userId, totpSecret: sealSecret(env, userId, secret) },
    });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  });

  beforeEach(async () => {
    resetTwoFactorFailuresForTests();
    await prisma.twoFactorSettings.update({ where: { userId }, data: { lastTotpStep: null } });
  });

  it("holds at five tries for guesses sent all at once, not only one at a time", async () => {
    const code = wrongCode();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => checkSecondFactor(env, userId, { code })),
    );
    const checked = results.filter((r) => !r.ok && r.reason.startsWith("That didn't match"));
    const refused = results.filter((r) => !r.ok && r.reason.startsWith("Too many wrong tries"));
    expect(checked).toHaveLength(5);
    expect(refused).toHaveLength(15);
    // Locked: even the right code is refused now.
    const right = totpCode(secret, Math.floor(Date.now() / 30_000));
    expect(await checkSecondFactor(env, userId, { code: right })).toMatchObject({ ok: false });
  });

  it("still lets the right code through after a few wrong ones, and starts the count again", async () => {
    const code = wrongCode();
    for (let i = 0; i < 4; i++) expect((await checkSecondFactor(env, userId, { code })).ok).toBe(false);
    const right = totpCode(secret, Math.floor(Date.now() / 30_000));
    expect(await checkSecondFactor(env, userId, { code: right })).toEqual({ ok: true });
    // The count started over: five more wrong tries before the pause.
    for (let i = 0; i < 5; i++)
      expect(await checkSecondFactor(env, userId, { code })).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/^That didn't match/),
      });
    expect(await checkSecondFactor(env, userId, { code })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^Too many wrong tries/),
    });
  });
});
