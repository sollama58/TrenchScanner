import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { amzDate, signV4 } from "../storage/s3.js";

/**
 * Custody for the trading bot's wallets: envelope encryption, so the database never holds a key
 * that can spend.
 *
 * Each wallet's 32-byte ed25519 seed is sealed with AES-256-GCM under its own random data key.
 * The data key is stored only wrapped by a key provider - in production AWS KMS, whose master key
 * never leaves AWS - so a full copy of the database (a leaked backup, a SQL injection) yields
 * ciphertext and nothing to open it with. Opening a wallet takes a KMS Decrypt call, which
 * CloudTrail logs and the IAM policy decides who may make.
 *
 * The split of permissions is the point: the API creates wallets and so only needs
 * kms:GenerateDataKey; the worker signs trades and withdrawals and so only needs kms:Decrypt.
 * Give each service its own IAM user with just that action on just this key, and the
 * internet-facing API process cannot open a wallet even if it is fully compromised.
 *
 * Every wrap is bound to the wallet it belongs to with an encryption context (KMS) or the GCM
 * associated data (both layers): a sealed seed copied onto another user's row fails to open.
 *
 * The local provider wraps data keys with a master key from the environment instead. It exists
 * for local development and tests only; createKeyProvider refuses it in production.
 */

export interface WalletContext {
  userId: string;
  publicKey: string;
}

export interface KeyProvider {
  readonly name: "kms" | "local";
  /** Which master key wraps the data keys: the KMS key id/ARN, or "local:<fingerprint>". */
  readonly keyRef: string;
  generateDataKey(context: WalletContext): Promise<{ plaintext: Buffer; wrapped: Buffer }>;
  unwrapDataKey(wrapped: Buffer, context: WalletContext): Promise<Buffer>;
}

/** What is stored for a wallet (TradingWallet's columns). */
export interface SealedSecret {
  secretCiphertext: Buffer;
  secretIv: Buffer;
  secretAuthTag: Buffer;
  wrappedDataKey: Buffer;
  keyProvider: string;
  keyRef: string;
}

const PURPOSE = "trenchscanner-trading-wallet";

function encryptionContext(ctx: WalletContext): Record<string, string> {
  return { purpose: PURPOSE, userId: ctx.userId, publicKey: ctx.publicKey };
}

/** The GCM associated data: the same binding, as bytes. */
function aad(ctx: WalletContext): Buffer {
  return Buffer.from(`${PURPOSE}|${ctx.userId}|${ctx.publicKey}`, "utf8");
}

function gcmSeal(key: Buffer, plaintext: Buffer, associated: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(associated);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

function gcmOpen(key: Buffer, ciphertext: Buffer, iv: Buffer, authTag: Buffer, associated: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(associated);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** A fresh wallet: the 32-byte seed and its base58 public key. */
export function generateWalletKeypair(): { seed: Uint8Array; publicKey: string } {
  const seed = ed25519.utils.randomPrivateKey();
  return { seed, publicKey: bs58.encode(ed25519.getPublicKey(seed)) };
}

export async function sealWalletSecret(
  provider: KeyProvider,
  seed: Uint8Array,
  context: WalletContext,
): Promise<SealedSecret> {
  if (seed.length !== 32) throw new Error("a wallet seed is 32 bytes");
  const { plaintext: dataKey, wrapped } = await provider.generateDataKey(context);
  try {
    const sealed = gcmSeal(dataKey, Buffer.from(seed), aad(context));
    return {
      secretCiphertext: sealed.ciphertext,
      secretIv: sealed.iv,
      secretAuthTag: sealed.authTag,
      wrappedDataKey: wrapped,
      keyProvider: provider.name,
      keyRef: provider.keyRef,
    };
  } finally {
    dataKey.fill(0);
  }
}

/**
 * Opens a sealed seed and checks it is the key for `context.publicKey`. The caller must zero the
 * returned buffer once it has signed (`seed.fill(0)`).
 */
export async function openWalletSecret(
  provider: KeyProvider,
  sealed: Pick<
    SealedSecret,
    "secretCiphertext" | "secretIv" | "secretAuthTag" | "wrappedDataKey" | "keyProvider"
  >,
  context: WalletContext,
): Promise<Uint8Array> {
  if (sealed.keyProvider !== provider.name) {
    throw new Error(`wallet was sealed with ${sealed.keyProvider}, this process holds ${provider.name}`);
  }
  const dataKey = await provider.unwrapDataKey(Buffer.from(sealed.wrappedDataKey), context);
  try {
    const seed = gcmOpen(
      dataKey,
      Buffer.from(sealed.secretCiphertext),
      Buffer.from(sealed.secretIv),
      Buffer.from(sealed.secretAuthTag),
      aad(context),
    );
    if (bs58.encode(ed25519.getPublicKey(seed)) !== context.publicKey) {
      seed.fill(0);
      throw new Error("opened seed does not match the wallet's public key");
    }
    return new Uint8Array(seed.buffer, seed.byteOffset, seed.byteLength);
  } finally {
    dataKey.fill(0);
  }
}

// ── Local provider (development only) ────────────────────────────────────────────────────────

export function createLocalKeyProvider(masterKeyHex: string): KeyProvider {
  if (!/^[0-9a-fA-F]{64}$/.test(masterKeyHex)) {
    throw new Error("TRADING_LOCAL_MASTER_KEY must be 64 hex characters (openssl rand -hex 32)");
  }
  const master = Buffer.from(masterKeyHex, "hex");
  const fingerprint = createHash("sha256").update(master).digest("hex").slice(0, 12);
  const contextBytes = (ctx: WalletContext) => Buffer.from(JSON.stringify(encryptionContext(ctx)), "utf8");
  return {
    name: "local",
    keyRef: `local:${fingerprint}`,
    async generateDataKey(context) {
      const plaintext = randomBytes(32);
      const sealed = gcmSeal(master, plaintext, contextBytes(context));
      // iv (12) | tag (16) | ciphertext (32)
      return { plaintext, wrapped: Buffer.concat([sealed.iv, sealed.authTag, sealed.ciphertext]) };
    },
    async unwrapDataKey(wrapped, context) {
      if (wrapped.length !== 12 + 16 + 32) throw new Error("malformed locally wrapped data key");
      return gcmOpen(
        master,
        wrapped.subarray(28),
        wrapped.subarray(0, 12),
        wrapped.subarray(12, 28),
        contextBytes(context),
      );
    },
  };
}

// ── AWS KMS ──────────────────────────────────────────────────────────────────────────────────

export interface KmsConfig {
  /** The KMS key's id, ARN or alias ARN. */
  keyId: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** For temporary credentials (an assumed role); empty otherwise. */
  sessionToken?: string;
  /** Override for tests or a VPC endpoint. Default https://kms.<region>.amazonaws.com. */
  endpoint?: string;
}

/**
 * The two KMS calls the vault makes, over KMS's JSON API with SigV4 signing (storage/s3.ts already
 * signs; KMS is the same algorithm with service "kms"), so the AWS SDK stays out of the build.
 */
export async function kmsCall<T>(
  cfg: KmsConfig,
  action: "GenerateDataKey" | "Decrypt",
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const url = new URL(cfg.endpoint ?? `https://kms.${cfg.region}.amazonaws.com/`);
  const payload = JSON.stringify(body);
  const payloadHash = createHash("sha256").update(payload).digest("hex");
  const headers: Record<string, string> = {
    "content-type": "application/x-amz-json-1.1",
    host: url.host,
    "x-amz-date": amzDate(new Date()),
    "x-amz-target": `TrentService.${action}`,
  };
  if (cfg.sessionToken) headers["x-amz-security-token"] = cfg.sessionToken;
  const authorization = signV4({
    method: "POST",
    url,
    headers,
    payloadHash,
    region: cfg.region,
    service: "kms",
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
  });
  const { host: _host, ...sent } = headers;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { ...sent, authorization },
    body: payload,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) {
    // KMS errors are {"__type": "...", "message": "..."}; neither carries key material.
    let kind = `HTTP ${res.status}`;
    try {
      const err = JSON.parse(text) as { __type?: string; message?: string; Message?: string };
      kind = `${err.__type ?? kind}: ${err.message ?? err.Message ?? ""}`.trim();
    } catch {
      /* not JSON */
    }
    throw new Error(`KMS ${action} failed - ${kind}`);
  }
  return JSON.parse(text) as T;
}

export function createKmsKeyProvider(cfg: KmsConfig, fetchImpl?: typeof fetch): KeyProvider {
  return {
    name: "kms",
    keyRef: cfg.keyId,
    async generateDataKey(context) {
      const out = await kmsCall<{ CiphertextBlob: string; Plaintext: string }>(
        cfg,
        "GenerateDataKey",
        { KeyId: cfg.keyId, KeySpec: "AES_256", EncryptionContext: encryptionContext(context) },
        fetchImpl,
      );
      const plaintext = Buffer.from(out.Plaintext, "base64");
      if (plaintext.length !== 32) throw new Error("KMS returned a data key of the wrong size");
      return { plaintext, wrapped: Buffer.from(out.CiphertextBlob, "base64") };
    },
    async unwrapDataKey(wrapped, context) {
      const out = await kmsCall<{ Plaintext: string }>(
        cfg,
        "Decrypt",
        {
          CiphertextBlob: wrapped.toString("base64"),
          // Pinning the key stops a wrapped key under some other KMS key from being accepted.
          KeyId: cfg.keyId,
          EncryptionContext: encryptionContext(context),
        },
        fetchImpl,
      );
      return Buffer.from(out.Plaintext, "base64");
    },
  };
}

export interface TradingKeyEnv {
  NODE_ENV?: string;
  TRADING_KEY_PROVIDER: "kms" | "local";
  TRADING_KMS_KEY_ID: string;
  TRADING_KMS_REGION: string;
  TRADING_AWS_ACCESS_KEY_ID: string;
  TRADING_AWS_SECRET_ACCESS_KEY: string;
  TRADING_AWS_SESSION_TOKEN: string;
  TRADING_LOCAL_MASTER_KEY: string;
}

/** The provider this process is configured for, or null (with why) when it has none. */
export function createKeyProvider(
  env: TradingKeyEnv,
  fetchImpl?: typeof fetch,
): { provider: KeyProvider; reason?: undefined } | { provider: null; reason: string } {
  if (env.TRADING_KEY_PROVIDER === "local") {
    if (env.NODE_ENV === "production") {
      return { provider: null, reason: "the local key provider is refused in production; use kms" };
    }
    if (!env.TRADING_LOCAL_MASTER_KEY)
      return { provider: null, reason: "TRADING_LOCAL_MASTER_KEY is not set" };
    return { provider: createLocalKeyProvider(env.TRADING_LOCAL_MASTER_KEY) };
  }
  const missing = (
    [
      "TRADING_KMS_KEY_ID",
      "TRADING_KMS_REGION",
      "TRADING_AWS_ACCESS_KEY_ID",
      "TRADING_AWS_SECRET_ACCESS_KEY",
    ] as const
  ).filter((k) => !env[k]);
  if (missing.length > 0) return { provider: null, reason: `${missing.join(", ")} not set` };
  return {
    provider: createKmsKeyProvider(
      {
        keyId: env.TRADING_KMS_KEY_ID,
        region: env.TRADING_KMS_REGION,
        accessKeyId: env.TRADING_AWS_ACCESS_KEY_ID,
        secretAccessKey: env.TRADING_AWS_SECRET_ACCESS_KEY,
        sessionToken: env.TRADING_AWS_SESSION_TOKEN || undefined,
      },
      fetchImpl,
    ),
  };
}
