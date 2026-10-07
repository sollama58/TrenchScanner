// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import bs58 from "bs58";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  loadEnv,
  prisma,
  SolanaRpc,
  SPL_TOKEN_PROGRAM_ID,
  SUBSCRIPTION_MINT,
  SUBSCRIPTION_RAW_PER_MONTH,
  type ParsedTransaction,
} from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { firstSignature } from "./subscription.js";
import { buildWireTransaction, burnInstruction, toBase64 } from "../burnWire.fixture.js";

const FIXTURE_OWNER = bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const FIXTURE_ACCOUNT = bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => 200 - i));
const FIXTURE_BLOCKHASH = bs58.encode(Uint8Array.from({ length: 32 }, () => 9));

/** A signed burn of the subscription mint on the wire, the way the dashboard builds one. */
function signedTx(signatureByte = 7, mint = SUBSCRIPTION_MINT): { base64: string; signature: string } {
  const bytes = buildWireTransaction({
    owner: FIXTURE_OWNER,
    blockhash: FIXTURE_BLOCKHASH,
    instructions: [burnInstruction(FIXTURE_ACCOUNT, mint, FIXTURE_OWNER, SUBSCRIPTION_RAW_PER_MONTH)],
    signatures: [signatureByte],
  });
  return { base64: toBase64(bytes), signature: bs58.encode(Buffer.alloc(64, signatureByte)) };
}

describe("firstSignature", () => {
  it("reads the transaction id off the signed bytes", () => {
    const { base64, signature } = signedTx();
    expect(firstSignature(base64)).toBe(signature);
  });

  it("refuses an unsigned or truncated payload", () => {
    expect(firstSignature(Buffer.concat([Buffer.from([1]), Buffer.alloc(64)]).toString("base64"))).toBeNull();
    expect(firstSignature(Buffer.from([1, 2, 3]).toString("base64"))).toBeNull();
    expect(firstSignature(Buffer.from([0]).toString("base64"))).toBeNull();
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `subscription-route-test-${Date.now()}`;

describe.skipIf(!dbAvailable)("subscription routes", () => {
  let app: FastifyInstance;
  const env = loadEnv({ ...process.env });
  const signer = createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS);

  beforeAll(async () => {
    app = await buildServer(env);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app?.close();
    if (dbAvailable) {
      await prisma.burnEvent.deleteMany({ where: { burnerWallet: { startsWith: TAG } } });
      await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
    }
  });

  async function signIn(name: string) {
    const walletAddress = `${TAG}-${name}`;
    const user = await prisma.user.create({ data: { walletAddress } });
    const cookie = await signer.sign({ userId: user.id, walletAddress, sessionVersion: 0 });
    return { userId: user.id, walletAddress, cookies: { [SESSION_COOKIE_NAME]: cookie } };
  }

  function burnTx(signature: string, authority: string): ParsedTransaction {
    return {
      slot: 1,
      blockTime: Math.floor(Date.now() / 1000),
      transaction: {
        signatures: [signature],
        message: {
          instructions: [
            {
              program: "spl-token",
              programId: SPL_TOKEN_PROGRAM_ID,
              parsed: {
                type: "burn",
                info: { mint: SUBSCRIPTION_MINT, authority, amount: SUBSCRIPTION_RAW_PER_MONTH.toString() },
              },
            },
          ],
        },
      },
      meta: { err: null, innerInstructions: null },
    };
  }

  /** A fresh signature-shaped string per test, so ledger rows never collide across runs. */
  function newSignature(): string {
    return bs58.encode(Buffer.from(Array.from({ length: 64 }, () => Math.floor(Math.random() * 256))));
  }

  it("credits the caller's own burn and reports their new access", async () => {
    const me = await signIn("own");
    const signature = newSignature();
    vi.spyOn(SolanaRpc.prototype, "getParsedTransaction").mockResolvedValue(
      burnTx(signature, me.walletAddress),
    );

    const res = await app.inject({
      method: "POST",
      url: "/subscription/claim",
      cookies: me.cookies,
      payload: { signature },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "credited", hasAccess: true });
  });

  it("does not tell a caller a burn by another account counted for them", async () => {
    const burner = await signIn("burner");
    const caller = await signIn("caller");
    const signature = newSignature();
    vi.spyOn(SolanaRpc.prototype, "getParsedTransaction").mockResolvedValue(
      burnTx(signature, burner.walletAddress),
    );

    const res = await app.inject({
      method: "POST",
      url: "/subscription/claim",
      cookies: caller.cookies,
      payload: { signature },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: "held" });

    // The months went to the wallet that burned, and only to it.
    const [burnerSub, callerSub] = await Promise.all([
      prisma.subscription.findUnique({ where: { userId: burner.userId } }),
      prisma.subscription.findUnique({ where: { userId: caller.userId } }),
    ]);
    expect(burnerSub?.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(callerSub).toBeNull();
  });

  it("relays only a transaction that burns the mint", async () => {
    const me = await signIn("relay-not-a-burn");
    const send = vi.spyOn(SolanaRpc.prototype, "sendRawTransaction");
    const otherMint = bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => 100 + i));
    const res = await app.inject({
      method: "POST",
      url: "/subscription/send",
      cookies: me.cookies,
      payload: { transaction: signedTx(7, otherMint).base64 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/doesn't burn/);
    expect(send).not.toHaveBeenCalled();
  });

  it("says a refused relay left the tokens alone", async () => {
    const me = await signIn("relay-refused");
    vi.spyOn(SolanaRpc.prototype, "sendRawTransaction").mockResolvedValue({
      error: "Transaction simulation failed",
      rejected: true,
    });
    const res = await app.inject({
      method: "POST",
      url: "/subscription/send",
      cookies: me.cookies,
      payload: { transaction: signedTx().base64 },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/not burned/);
    expect(res.json().signature).toBeUndefined();
  });

  it("does not promise the tokens are safe when the relay's reply was lost", async () => {
    const me = await signIn("relay-lost");
    vi.spyOn(SolanaRpc.prototype, "sendRawTransaction").mockResolvedValue({
      error: "HTTP 408",
      rejected: false,
    });
    const tx = signedTx(9);
    const res = await app.inject({
      method: "POST",
      url: "/subscription/send",
      cookies: me.cookies,
      payload: { transaction: tx.base64 },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).not.toMatch(/not burned/);
    expect(res.json().signature).toBe(tx.signature);
  });

  it("offers only the SPL Token accounts a burn can come from, largest first", async () => {
    const me = await signIn("balance");
    vi.spyOn(SolanaRpc.prototype, "getTokenAccountsByOwner").mockResolvedValue([
      { address: "small", programId: SPL_TOKEN_PROGRAM_ID, rawAmount: "5", state: "initialized" },
      { address: "big", programId: SPL_TOKEN_PROGRAM_ID, rawAmount: "70000000000", state: "initialized" },
      { address: "frozen", programId: SPL_TOKEN_PROGRAM_ID, rawAmount: "90000000000", state: "frozen" },
      {
        address: "t22",
        programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
        rawAmount: "1",
        state: "initialized",
      },
    ]);
    const res = await app.inject({ method: "GET", url: "/subscription/balance", cookies: me.cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json().accounts.map((a: { address: string }) => a.address)).toEqual(["big", "small"]);
    expect(res.json().totalRaw).toBe("160000000006");
  });

  it("says so when the balance can't be read", async () => {
    const me = await signIn("balance-down");
    vi.spyOn(SolanaRpc.prototype, "getTokenAccountsByOwner").mockResolvedValue(null);
    const res = await app.inject({ method: "GET", url: "/subscription/balance", cookies: me.cookies });
    expect(res.statusCode).toBe(503);
  });
});
