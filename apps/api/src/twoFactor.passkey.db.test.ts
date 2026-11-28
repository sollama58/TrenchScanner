// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { createHash, generateKeyPairSync, randomBytes, sign as signWith, type KeyObject } from "node:crypto";
import bs58 from "bs58";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { prisma, type Env } from "@trenchscanner/core";
import {
  checkSecondFactor,
  finishPasskeyRegistration,
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  relyingParty,
  resetTwoFactorFailuresForTests,
} from "./twoFactor.js";

/**
 * Passkey two-factor, end to end against the database (program audit 2026-11-28, CH-2). Nothing
 * ran registration, the sign-in options or the passkey branch of the factor check: the ticket's
 * subject, its single use, the credential's owner and the counter could each be dropped with the
 * api suite green. A software authenticator stands in for the device: a P-256 key that builds the
 * attestation and signs the assertions the way an authenticator does.
 */
const env = { JWT_SECRET: "p".repeat(64), PUBLIC_APP_DOMAIN: "holdex.live" } as Env;
const ORIGIN = "https://holdex.live";
const RP_ID = "holdex.live";

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest();

class SoftwareAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly privateKey: KeyObject;
  private readonly cosePublicKey: Uint8Array;
  private counter = 0;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    // COSE_Key: kty EC2 (2), alg ES256 (-7), crv P-256 (1), x, y.
    this.cosePublicKey = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, "base64url")],
        [-3, Buffer.from(jwk.y!, "base64url")],
      ]),
    );
  }

  get id(): string {
    return b64url(this.credentialId);
  }

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  private authData(rpId: string, attested: boolean): Buffer {
    this.counter += 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    // Flags: user present and verified (0x05), plus attested credential data (0x40) on create.
    const head = Buffer.concat([sha256(rpId), Buffer.from([attested ? 0x45 : 0x05]), counter]);
    if (!attested) return head;
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    return Buffer.concat([head, Buffer.alloc(16), idLength, this.credentialId, this.cosePublicKey]);
  }

  /** navigator.credentials.create(): attestation "none". */
  create(challenge: string, origin = ORIGIN, rpId = RP_ID): RegistrationResponseJSON {
    const attestationObject = isoCBOR.encode(
      new Map<string, Parameters<typeof isoCBOR.encode>[0]>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", new Uint8Array(this.authData(rpId, true))],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64url(this.clientData("webauthn.create", challenge, origin)),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
    };
  }

  /** navigator.credentials.get(): an ES256 signature over authData and the client data's hash. */
  get(challenge: string, origin = ORIGIN, rpId = RP_ID): AuthenticationResponseJSON {
    const clientDataJSON = this.clientData("webauthn.get", challenge, origin);
    const authenticatorData = this.authData(rpId, false);
    const signature = signWith(
      "sha256",
      Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
      this.privateKey,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
      },
      clientExtensionResults: {},
    };
  }
}

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe.skipIf(!dbAvailable)("passkey two-factor", () => {
  let alice: string;
  let bob: string;
  const users: string[] = [];

  async function newUser(): Promise<string> {
    const user = await prisma.user.create({ data: { walletAddress: bs58.encode(randomBytes(32)) } });
    users.push(user.id);
    return user.id;
  }

  /** Registers a new passkey for the user and returns its authenticator. */
  async function register(userId: string): Promise<SoftwareAuthenticator> {
    const device = new SoftwareAuthenticator();
    const start = await passkeyRegistrationOptions(env, userId, "tester", ORIGIN);
    expect(start).not.toBeNull();
    const ok = await finishPasskeyRegistration(
      env,
      userId,
      start!.token,
      device.create(start!.options.challenge),
      "Laptop",
      ORIGIN,
    );
    expect(ok).toBe(true);
    return device;
  }

  async function ticket(userId: string) {
    const start = await passkeyAuthenticationOptions(env, userId, ORIGIN);
    expect(start).not.toBeNull();
    return start!;
  }

  beforeAll(async () => {
    alice = await newUser();
    bob = await newUser();
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  });

  beforeEach(() => {
    resetTwoFactorFailuresForTests();
  });

  it("names the relying party from a listed dashboard only", () => {
    expect(relyingParty(env, ORIGIN)).toEqual({ rpID: RP_ID, origin: ORIGIN });
    expect(relyingParty(env, "https://evil.example")).toBeNull();
    expect(relyingParty(env, undefined)).toBeNull();
    expect(relyingParty(env, "not a url")).toBeNull();
  });

  it("registers a passkey once: the same ticket, or the same credential, is refused after", async () => {
    const device = new SoftwareAuthenticator();
    const start = (await passkeyRegistrationOptions(env, alice, "alice", ORIGIN))!;
    const response = device.create(start.options.challenge);
    expect(await finishPasskeyRegistration(env, alice, start.token, response, "  Phone  ", ORIGIN)).toBe(
      true,
    );
    const row = await prisma.twoFactorPasskey.findUniqueOrThrow({ where: { credentialId: device.id } });
    expect(row).toMatchObject({ userId: alice, name: "Phone", transports: ["internal"] });

    // The registration ticket is single use.
    expect(await finishPasskeyRegistration(env, alice, start.token, response, "Phone", ORIGIN)).toBe(false);
    // A fresh ticket, the same credential on another account: refused, not a server error.
    const again = (await passkeyRegistrationOptions(env, bob, "bob", ORIGIN))!;
    expect(
      await finishPasskeyRegistration(
        env,
        bob,
        again.token,
        device.create(again.options.challenge),
        "x",
        ORIGIN,
      ),
    ).toBe(false);
    // The next registration leaves this credential out of what the browser may create again.
    const next = (await passkeyRegistrationOptions(env, alice, "alice", ORIGIN))!;
    expect(next.options.excludeCredentials?.map((c) => c.id)).toContain(device.id);
  });

  it("refuses a registration made for another user's ticket, another challenge or another origin", async () => {
    const device = new SoftwareAuthenticator();
    const start = (await passkeyRegistrationOptions(env, alice, "alice", ORIGIN))!;
    // Bob presenting Alice's ticket.
    expect(
      await finishPasskeyRegistration(
        env,
        bob,
        start.token,
        device.create(start.options.challenge),
        "x",
        ORIGIN,
      ),
    ).toBe(false);
    // The wrong challenge, then a response made on a phishing page.
    const second = (await passkeyRegistrationOptions(env, alice, "alice", ORIGIN))!;
    expect(
      await finishPasskeyRegistration(env, alice, second.token, device.create("AAAA"), "x", ORIGIN),
    ).toBe(false);
    const third = (await passkeyRegistrationOptions(env, alice, "alice", ORIGIN))!;
    const phished = device.create(third.options.challenge, "https://evil.example");
    expect(await finishPasskeyRegistration(env, alice, third.token, phished, "x", ORIGIN)).toBe(false);
    expect(await prisma.twoFactorPasskey.count({ where: { credentialId: device.id } })).toBe(0);
    // No options at all for a page that is not a listed dashboard.
    expect(await passkeyRegistrationOptions(env, alice, "alice", "https://evil.example")).toBeNull();
  });

  it("passes the factor check with the user's own passkey, once per ticket, and moves the counter", async () => {
    const user = await newUser();
    expect(await passkeyAuthenticationOptions(env, user, ORIGIN)).toBeNull();
    const device = await register(user);
    const start = await ticket(user);
    expect(start.options.allowCredentials?.map((c) => c.id)).toEqual([device.id]);
    const response = device.get(start.options.challenge);
    const factor = { passkey: { token: start.token, response } };
    expect(await checkSecondFactor(env, user, factor, ORIGIN)).toEqual({ ok: true });
    const row = await prisma.twoFactorPasskey.findUniqueOrThrow({ where: { credentialId: device.id } });
    // The authenticator's counter: 1 at registration, 2 on this assertion.
    expect(row.counter).toBe(2n);
    expect(row.lastUsedAt).not.toBeNull();

    // The same ticket and assertion again is a replay.
    expect(await checkSecondFactor(env, user, factor, ORIGIN)).toMatchObject({ ok: false });
    // A new ticket works again.
    const next = await ticket(user);
    expect(
      await checkSecondFactor(
        env,
        user,
        { passkey: { token: next.token, response: device.get(next.options.challenge) } },
        ORIGIN,
      ),
    ).toEqual({ ok: true });
  });

  it("refuses another user's passkey, another user's ticket, a phishing origin and a forged signature", async () => {
    const mine = await newUser();
    const theirs = await newUser();
    const myDevice = await register(mine);
    const theirDevice = await register(theirs);
    const check = async (
      userId: string,
      token: string,
      response: AuthenticationResponseJSON,
      origin = ORIGIN,
    ) => (await checkSecondFactor(env, userId, { passkey: { token, response } }, origin)).ok;

    // My ticket answered with their passkey: a true signature, by a credential that is not mine.
    let start = await ticket(mine);
    expect(await check(mine, start.token, theirDevice.get(start.options.challenge))).toBe(false);
    // Their ticket presented for my account.
    const foreign = await ticket(theirs);
    expect(await check(mine, foreign.token, myDevice.get(foreign.options.challenge))).toBe(false);
    // An assertion made on a phishing page, and one the API is asked about from an unlisted page.
    start = await ticket(mine);
    expect(
      await check(mine, start.token, myDevice.get(start.options.challenge, "https://evil.example")),
    ).toBe(false);
    start = await ticket(mine);
    expect(
      await check(mine, start.token, myDevice.get(start.options.challenge), "https://evil.example"),
    ).toBe(false);
    // The right credential id with a signature another key made.
    resetTwoFactorFailuresForTests();
    start = await ticket(mine);
    const forged = { ...theirDevice.get(start.options.challenge), id: myDevice.id, rawId: myDevice.id };
    expect(await check(mine, start.token, forged)).toBe(false);
    // An answer to another challenge.
    start = await ticket(mine);
    expect(await check(mine, start.token, myDevice.get("AAAA"))).toBe(false);

    // None of it moved my passkey's counter or marked it used.
    const row = await prisma.twoFactorPasskey.findUniqueOrThrow({ where: { credentialId: myDevice.id } });
    expect(row.counter).toBe(1n);
    expect(row.lastUsedAt).toBeNull();
    // And the real thing still works.
    resetTwoFactorFailuresForTests();
    start = await ticket(mine);
    expect(await check(mine, start.token, myDevice.get(start.options.challenge))).toBe(true);
  });
});
