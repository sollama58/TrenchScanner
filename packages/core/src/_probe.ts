import bs58 from "bs58";
import { findProgramAddress } from "./solana.js";
const t = (s: string) => new TextEncoder().encode(s);
const mint = process.argv[2]!,
  quote = process.argv[3]!;
const pc = findProgramAddress(
  [t("pool-authority"), bs58.decode(mint)],
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
);
console.log(
  findProgramAddress([t("bonding-curve"), bs58.decode(mint)], "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"),
);
console.log(
  findProgramAddress(
    [t("pool"), new Uint8Array([0, 0]), bs58.decode(pc), bs58.decode(mint), bs58.decode(quote)],
    "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  ),
);
