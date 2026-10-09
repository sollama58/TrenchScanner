import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import { loadServerWalletKey, parseServerWalletKey, serverWithdrawTo } from "./serverWallet.js";
import { generateWalletKeypair } from "./keyVault.js";

function exported() {
  const seed = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(seed);
  return { seed, publicKey: bs58.encode(pub), secret64: Uint8Array.from([...seed, ...pub]) };
}

describe("server wallet key", () => {
  it("reads every way wallets export a key", () => {
    const k = exported();
    expect(parseServerWalletKey(bs58.encode(k.secret64)).publicKey).toBe(k.publicKey); // Phantom
    expect(parseServerWalletKey(bs58.encode(k.seed)).publicKey).toBe(k.publicKey); // a bare seed
    expect(parseServerWalletKey(JSON.stringify([...k.secret64])).publicKey).toBe(k.publicKey); // solana-keygen
    expect(parseServerWalletKey(`  ${bs58.encode(k.secret64)}\n`).publicKey).toBe(k.publicKey);
  });

  it("refuses malformed or inconsistent keys without echoing them", () => {
    const k = exported();
    const swapped = Uint8Array.from([...k.seed, ...bs58.decode(generateWalletKeypair().publicKey)]);
    expect(() => parseServerWalletKey(bs58.encode(swapped))).toThrow(/inconsistent/);
    expect(() => parseServerWalletKey(bs58.encode(k.seed.slice(0, 20)))).toThrow(/20 bytes/);
    expect(() => parseServerWalletKey("not-base58-0OIl")).toThrow(/not base58/);
    try {
      parseServerWalletKey(bs58.encode(swapped));
    } catch (err) {
      expect(String(err)).not.toContain(bs58.encode(swapped));
    }
  });

  it("only loads a key that belongs to the declared address", () => {
    const k = exported();
    const secret = bs58.encode(k.secret64);
    const to = generateWalletKeypair().publicKey;
    const env = {
      TRADING_SERVER_WALLET_SECRET_KEY: secret,
      TRADING_SERVER_WALLET_ADDRESS: k.publicKey,
      TRADING_SERVER_WALLET_WITHDRAW_TO: to,
    };
    const ok = loadServerWalletKey(env);
    expect(ok.key?.publicKey).toBe(k.publicKey);
    expect(ok.key?.withdrawTo).toBe(to);
    expect(loadServerWalletKey({ ...env, TRADING_SERVER_WALLET_ADDRESS: to }).problem).toMatch(
      /does not belong/,
    );
    expect(loadServerWalletKey({ ...env, TRADING_SERVER_WALLET_ADDRESS: "" }).problem).toMatch(
      /ADDRESS must be set/,
    );
    expect(loadServerWalletKey({ ...env, TRADING_SERVER_WALLET_WITHDRAW_TO: k.publicKey }).problem).toMatch(
      /itself/,
    );
    expect(loadServerWalletKey({ ...env, TRADING_SERVER_WALLET_SECRET_KEY: "" })).toEqual({
      key: null,
      problem: null,
    });
    expect(serverWithdrawTo({ TRADING_SERVER_WALLET_WITHDRAW_TO: "nonsense" })).toBeNull();
  });
});
