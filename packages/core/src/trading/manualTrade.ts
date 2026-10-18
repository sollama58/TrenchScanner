import { TransientError } from "./errors.js";
import { NoRouteError, RateLimitedError, WSOL_MINT, type SwapQuote } from "./jupiterSwap.js";
import {
  curveRefusal,
  parsePumpCurve,
  pumpBuyInstructions,
  pumpCurveAddress,
  pumpBuybackRecipient,
  pumpSellInstructions,
  PUMP_GLOBAL,
} from "./pumpCurve.js";
import { pickSenderTipAccount, SENDER_MIN_TIP_LAMPORTS, type SenderSpeed } from "./sender.js";
import {
  buildV0Transaction,
  computeBudgetInstructions,
  parseLookupTableAddresses,
  priorityFeeOf,
  systemTransferInstruction,
  type DecodedInstruction,
  type DecodedMessage,
  type InstructionSpec,
} from "./transaction.js";
import {
  GuardRefusal,
  guardSwapTransaction,
  PROGRAM,
  readJupiterRoute,
  type GuardRpc,
  type TradeExpectation,
} from "./txGuard.js";

/**
 * A Pro trade from the token modal: a swap built here for the trader's OWN wallet to sign in their
 * browser. Nothing here holds a key or signs; the API hands back unsigned bytes, the wallet
 * signs, and the signed transaction goes out through Helius Sender (sender.ts).
 *
 * No fee is taken (owner decision 2026-10-17): the route is Jupiter's, whose route instruction
 * the guard reads to make sure it carries no platform fee, or for a curve coin Jupiter can't
 * route yet, the Pump.fun program's own instructions (pumpCurve.ts). Never PumpPortal. What the
 * trader pays beyond the swap itself is the network's: a priority fee and Sender's small tip.
 *
 * Every build passes the same guard the bot's swaps do (txGuard.ts: allowed programs only, no
 * other token account touched, at least the quoted minimum out, no more SOL out than asked) with
 * its simulation, before the bytes are returned - so a hostile or broken route is refused here,
 * not left to the wallet's warning screen.
 */

export interface ManualTradeRpc extends GuardRpc {
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number } | null>;
  getMintInfo(mint: string): Promise<{ program: string; decimals?: number } | null>;
  getPriorityFeeEstimate(accounts: string[]): Promise<bigint | null>;
}

export interface ManualTradeJupiter {
  quote(input: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
  }): Promise<SwapQuote>;
  swapInstructions(input: { quote: SwapQuote; userPublicKey: string }): Promise<{
    instructions: InstructionSpec[];
    lookupTables: string[];
    computeUnitLimit: number | null;
  }>;
}

export interface ManualTradeRequest {
  wallet: string;
  mint: string;
  side: "buy" | "sell";
  /** Buy: lamports to spend. Sell: raw token units. */
  amount: bigint;
  slippageBps: number;
  speed: SenderSpeed;
  /** The trader's own priority fee, in lamports (instead of the network's going rate). */
  priorityFeeLamports?: bigint;
  /** The trader's own Sender tip, in lamports: at least the speed's minimum. */
  tipLamports?: bigint;
}

export interface ManualTrade {
  /** Unsigned, base64: the wallet signs it. */
  transaction: string;
  lastValidBlockHeight: number;
  route: "jupiter" | "pump";
  /** What the route expects out (raw tokens for a buy, lamports for a sale) and the least it may give. */
  quotedOut: string;
  minOut: string;
  tipLamports: string;
  priorityFeeLamports: string;
}

/** The slippage a Pro trade may ask for, in bps (50%: a launch can move that much in a slot). */
export const MAX_MANUAL_SLIPPAGE_BPS = 5_000;
/** The largest buy one click may make, in lamports (a typo guard, not a limit on anyone's size). */
export const MAX_MANUAL_BUY_LAMPORTS = 100_000_000_000n;
/** The priority fee's ceiling on each tier, in lamports: eco is meant to cost next to nothing. */
const PRIORITY_CAP_LAMPORTS: Record<SenderSpeed, bigint> = { eco: 50_000n, turbo: 1_000_000n };
/** The most a trader may set as their own priority fee or tip, each (a typo guard): 0.01 SOL. */
export const MAX_CUSTOM_FEE_LAMPORTS = 10_000_000n;
/** The price floor per compute unit, so a quiet network still sees a priority fee (Sender needs one). */
const MIN_MICROLAMPORTS = 10_000n;
/** Room under a buy for rent (the token and wrapped-SOL accounts) and base fees. */
const BUY_MARGIN_LAMPORTS = 5_000_000n;
/** Room under a sale's minimum: base fee and rounding. */
const SELL_MARGIN_LAMPORTS = 100_000n;
/** Compute units for the curve's own trades (measured on mainnet), with room. */
const PUMP_BUY_UNITS = 150_000;
const PUMP_SELL_UNITS = 120_000;
/** Jupiter's simulated limit plus room for the budget and tip instructions. */
const JUPITER_UNIT_SLACK = 1.15;
const JUPITER_UNIT_EXTRA = 5_000;
const DEFAULT_JUPITER_UNITS = 400_000;
/** The unit limit's bounds: Jupiter's number is untrusted, and the runtime allows 1.4M at most. */
const MIN_UNITS = 100_000;
const MAX_UNITS = 1_400_000;
/** Jupiter's exact-in route variants, whose arguments end in quoted_out (u64), slippage (u16), fee (u8). */
const JUPITER_EXACT_IN_ROUTES = new Set(["route", "shared_accounts_route"]);

/** Instructions the guard reads: their accounts stay out of lookup tables. */
const STATIC_PROGRAMS = new Set<string>([
  PROGRAM.system,
  PROGRAM.token,
  PROGRAM.token2022,
  PROGRAM.ata,
  PROGRAM.computeBudget,
]);

/** A trade request that can't be built as asked (bad size, no route): the trader's to fix. */
export class TradeRejected extends Error {}

/** Builds, guards and returns a Pro trade for the trader's wallet to sign. */
export async function buildManualTrade(
  deps: { rpc: ManualTradeRpc; jupiter: ManualTradeJupiter; random?: () => number },
  req: ManualTradeRequest,
): Promise<ManualTrade> {
  if (req.amount <= 0n) throw new TradeRejected("the amount must be more than zero");
  if (req.side === "buy" && req.amount > MAX_MANUAL_BUY_LAMPORTS)
    throw new TradeRejected("that buy is over 100 SOL: split it up");
  if (!Number.isInteger(req.slippageBps) || req.slippageBps < 10 || req.slippageBps > MAX_MANUAL_SLIPPAGE_BPS)
    throw new TradeRejected(`slippage must be between 0.1% and ${MAX_MANUAL_SLIPPAGE_BPS / 100}%`);
  const buy = req.side === "buy";
  const mintInfo = await deps.rpc.getMintInfo(req.mint);
  if (!mintInfo) throw new TransientError("couldn't read the token's mint");
  if (mintInfo.program !== PROGRAM.token && mintInfo.program !== PROGRAM.token2022)
    throw new TradeRejected("not a token this can trade");

  if (
    req.priorityFeeLamports !== undefined &&
    (req.priorityFeeLamports < 0n || req.priorityFeeLamports > MAX_CUSTOM_FEE_LAMPORTS)
  )
    throw new TradeRejected("the priority fee must be between 0 and 0.01 SOL");
  if (
    req.tipLamports !== undefined &&
    (req.tipLamports < SENDER_MIN_TIP_LAMPORTS[req.speed] || req.tipLamports > MAX_CUSTOM_FEE_LAMPORTS)
  )
    throw new TradeRejected(
      `the tip must be between ${Number(SENDER_MIN_TIP_LAMPORTS[req.speed]) / 1e9} and 0.01 SOL on this speed`,
    );
  const tip = req.tipLamports ?? SENDER_MIN_TIP_LAMPORTS[req.speed];
  const tipIx = systemTransferInstruction(req.wallet, pickSenderTipAccount(deps.random), tip);

  // Jupiter first; the curve's own instructions when Jupiter has no route (or is unreachable).
  let route: ManualTrade["route"];
  let swapIxs: InstructionSpec[];
  let tables: string[] = [];
  let units: number;
  let quotedOut: bigint;
  let minOut: bigint;
  try {
    const quote = await deps.jupiter.quote({
      inputMint: buy ? WSOL_MINT : req.mint,
      outputMint: buy ? req.mint : WSOL_MINT,
      amount: req.amount,
      slippageBps: req.slippageBps,
    });
    const built = await deps.jupiter.swapInstructions({ quote, userPublicKey: req.wallet });
    route = "jupiter";
    swapIxs = built.instructions.filter((ix) => ix.programId !== PROGRAM.computeBudget);
    tables = built.lookupTables;
    const limit = Math.ceil((built.computeUnitLimit ?? DEFAULT_JUPITER_UNITS) * JUPITER_UNIT_SLACK);
    units = Math.min(MAX_UNITS, Math.max(MIN_UNITS, limit + JUPITER_UNIT_EXTRA));
    quotedOut = BigInt(quote.outAmount);
    minOut = BigInt(quote.otherAmountThreshold);
    checkJupiterFloor(swapIxs, quotedOut, minOut, req.slippageBps);
  } catch (err) {
    if (!(err instanceof NoRouteError || err instanceof RateLimitedError || err instanceof TransientError))
      throw err;
    const curve = await readCurve(deps.rpc, req.mint, deps.random);
    const refusal = curveRefusal(curve.curve);
    if (refusal || !curve.curve || !curve.buyback)
      throw err instanceof NoRouteError
        ? new TradeRejected(`no route for this token (${refusal ?? "Pump.fun's fee recipients unreadable"})`)
        : err;
    route = "pump";
    const accounts = {
      wallet: req.wallet,
      mint: req.mint,
      tokenProgram: mintInfo.program,
      curve: curve.curve,
      buybackFeeRecipient: curve.buyback,
    };
    if (buy) {
      const b = (() => {
        try {
          return pumpBuyInstructions({ ...accounts, solIn: req.amount, slippageBps: req.slippageBps });
        } catch (err) {
          // Too small a buy for the curve to give a token: the trader's input, not a build failure.
          throw new TradeRejected(err instanceof Error ? err.message : String(err));
        }
      })();
      swapIxs = b.instructions;
      minOut = b.minTokens;
      units = PUMP_BUY_UNITS;
    } else {
      const s = pumpSellInstructions({ ...accounts, tokens: req.amount, slippageBps: req.slippageBps });
      swapIxs = s.instructions;
      minOut = s.minSol;
      units = PUMP_SELL_UNITS;
    }
    quotedOut = (minOut * 10_000n) / BigInt(10_000 - req.slippageBps);
  }

  const writable = [
    ...new Set(swapIxs.flatMap((ix) => ix.accounts.filter((a) => a.writable).map((a) => a.pubkey))),
  ];
  const [estimate, blockhash, tableData] = await Promise.all([
    deps.rpc.getPriorityFeeEstimate(writable),
    deps.rpc.getLatestBlockhash(),
    tables.length > 0 ? deps.rpc.getAccountsData(tables) : Promise.resolve([]),
  ]);
  if (!blockhash) throw new TransientError("couldn't read a recent blockhash");
  if (!tableData) throw new TransientError("couldn't read the route's lookup tables");
  const resolved = new Map<string, string[]>();
  tables.forEach((t, i) => {
    const data = tableData[i];
    if (!data) throw new TransientError(`lookup table ${t} not found`);
    resolved.set(t, parseLookupTableAddresses(data));
  });
  const price = priorityPrice(units, req.speed, estimate, req.priorityFeeLamports);
  const priorityFee = priorityFeeOf(units, price);

  const tx = buildV0Transaction(
    req.wallet,
    blockhash.blockhash,
    [...computeBudgetInstructions(units, price), ...swapIxs, tipIx],
    resolved,
    STATIC_PROGRAMS,
  );
  const limits = {
    maxExternalLamports: tip,
    maxPriorityFeeLamports: priorityFee,
    ...(route === "jupiter" ? { maxSlippageBps: req.slippageBps } : {}),
  };
  const expect: TradeExpectation = buy
    ? {
        kind: "buy",
        mint: req.mint,
        minOut,
        maxSolDrop: req.amount + priorityFee + tip + BUY_MARGIN_LAMPORTS,
        ...limits,
      }
    : {
        kind: "sell",
        mint: req.mint,
        amount: req.amount,
        minSolOut: minOut,
        feeAllowance: priorityFee + tip + SELL_MARGIN_LAMPORTS,
        ...limits,
      };
  await guardSwapTransaction(deps.rpc, tx, req.wallet, expect);
  return {
    transaction: Buffer.from(tx).toString("base64"),
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
    route,
    quotedOut: quotedOut.toString(),
    minOut: minOut.toString(),
    tipLamports: tip.toString(),
    priorityFeeLamports: priorityFee.toString(),
  };
}

/**
 * The floor the chain itself enforces on a Jupiter swap is its route instruction's quoted_out
 * less its slippage - not the quote's otherAmountThreshold, which only the guard's simulation
 * sees. So the route must be one this reads, exactly one, quoting at least what the quote did:
 * a response quoting 1 token would simulate fine and then land with no floor at all.
 */
export function checkJupiterFloor(
  ixs: InstructionSpec[],
  quotedOut: bigint,
  minOut: bigint,
  slippageBps: number,
): void {
  const routes = ixs
    .filter((ix) => ix.programId === PROGRAM.jupiterV6)
    .map((ix) => ({ ix, route: readJupiterRoute(Uint8Array.from(ix.data)) }));
  const read = routes.filter((r) => r.route !== null);
  // Every Jupiter instruction must be the one route read here: one it can't parse goes unchecked.
  if (read.length !== 1 || routes.length !== 1 || !JUPITER_EXACT_IN_ROUTES.has(read[0]!.route!.name))
    throw new GuardRefusal("Jupiter returned a route this can't check");
  const data = read[0]!.ix.data;
  let onChainQuote = 0n;
  for (let i = 7; i >= 0; i--) onChainQuote = (onChainQuote << 8n) | BigInt(data[data.length - 11 + i]!);
  if (quotedOut <= 0n || onChainQuote < quotedOut)
    throw new GuardRefusal("Jupiter's route quotes less than its own quote");
  if (read[0]!.route!.slippageBps > slippageBps)
    throw new GuardRefusal("Jupiter's route allows more slippage than asked");
  const floor = (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;
  if (minOut <= 0n || minOut < floor)
    throw new GuardRefusal("Jupiter's minimum is under the slippage asked for");
}

/**
 * The compute-unit price for a trade of `units`: the trader's own fee spread over the units, or
 * the network's going rate (with a floor, doubled on Turbo) capped at the speed's ceiling.
 */
function priorityPrice(units: number, speed: SenderSpeed, estimate: bigint | null, custom?: bigint): bigint {
  // At least 1 micro-lamport: Sender only takes a transaction that sets a price at all.
  if (custom !== undefined) {
    const p = (custom * 1_000_000n) / BigInt(units);
    return p > 0n ? p : 1n;
  }
  const capPrice = (PRIORITY_CAP_LAMPORTS[speed] * 1_000_000n) / BigInt(units);
  let price = estimate !== null && estimate > MIN_MICROLAMPORTS ? estimate : MIN_MICROLAMPORTS;
  if (speed === "turbo") price *= 2n;
  return price > capPrice ? capPrice : price;
}

/** A typical trade's compute units, for the fee shown before one is built. */
const TYPICAL_UNITS = 250_000;

/**
 * What a trade on `mint` would pay the network now, before it is built: the priority fee at the
 * going rate (or the trader's own) and Sender's tip. The panel shows it under the buttons.
 */
export async function estimateManualFees(
  rpc: Pick<ManualTradeRpc, "getPriorityFeeEstimate">,
  input: { mint: string; speed: SenderSpeed; priorityFeeLamports?: bigint; tipLamports?: bigint },
): Promise<{ priorityFeeLamports: bigint; tipLamports: bigint; baseFeeLamports: bigint }> {
  const estimate =
    input.priorityFeeLamports !== undefined
      ? null
      : await rpc.getPriorityFeeEstimate([input.mint, PROGRAM.jupiterV6, PROGRAM.pumpFun]);
  const price = priorityPrice(TYPICAL_UNITS, input.speed, estimate, input.priorityFeeLamports);
  return {
    priorityFeeLamports: priorityFeeOf(TYPICAL_UNITS, price),
    tipLamports: input.tipLamports ?? SENDER_MIN_TIP_LAMPORTS[input.speed],
    // One signature.
    baseFeeLamports: 5_000n,
  };
}

/** The coin's bonding curve and the fee recipient its trades pay, as far as they can be read. */
async function readCurve(rpc: ManualTradeRpc, mint: string, random?: () => number) {
  const address = pumpCurveAddress(mint);
  const data = await rpc.getAccountsData([address, PUMP_GLOBAL]);
  if (!data) throw new TransientError("couldn't read the bonding curve");
  const curve = data[0] ? parsePumpCurve(address, data[0]) : null;
  const buyback = data[1] ? pumpBuybackRecipient(data[1], random) : null;
  return { curve, buyback };
}

/** Lighthouse, whose assertion instructions Phantom and other wallets add to what they sign. */
export const LIGHTHOUSE_PROGRAM = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";

/**
 * Whether a transaction the wallet signed is the one built for it: same payer, signer and
 * blockhash, and the same instructions in the same order, each with the same program, accounts
 * and data. A wallet may set its own compute budget (within the custom-fee ceiling) and add
 * Lighthouse's guard assertions, so those are the only differences allowed. Accounts compare by
 * where they come from (a key in the message, or a lookup table's entry), so a wallet that
 * re-indexes the message to add its own keys still matches. Returns why not, or null.
 */
export function signedMatchesBuild(built: DecodedMessage, signed: DecodedMessage): string | null {
  if (signed.staticKeys[0] !== built.staticKeys[0]) return "a different fee payer";
  if (signed.requiredSignatures !== 1) return "more than one signer";
  if (signed.recentBlockhash !== built.recentBlockhash) return "a different blockhash";
  const program = (m: DecodedMessage, ix: DecodedInstruction) => m.staticKeys[ix.programIdIndex];
  const canonical = (m: DecodedMessage) => {
    const loaded = [
      ...m.lookups.flatMap((l) => l.writable.map((i) => `${l.table}#${i}`)),
      ...m.lookups.flatMap((l) => l.readonly.map((i) => `${l.table}#${i}`)),
    ];
    const key = (index: number) =>
      index < m.staticKeys.length ? m.staticKeys[index] : loaded[index - m.staticKeys.length];
    return m.instructions
      .filter((ix) => program(m, ix) !== PROGRAM.computeBudget && program(m, ix) !== LIGHTHOUSE_PROGRAM)
      .map(
        (ix) =>
          `${program(m, ix)}|${ix.accountIndexes.map(key).join(",")}|${Buffer.from(ix.data).toString("hex")}`,
      );
  };
  const a = canonical(built);
  const b = canonical(signed);
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) return "different instructions";
  // The wallet's own compute budget, if it set one, within the ceiling a trader may set.
  let limit = 200_000n;
  let price = 0n;
  for (const ix of signed.instructions) {
    if (program(signed, ix) !== PROGRAM.computeBudget) continue;
    const d = ix.data;
    const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
    if (d[0] === 2 && d.length >= 5) limit = BigInt(view.getUint32(1, true));
    else if (d[0] === 3 && d.length >= 9) price = view.getBigUint64(1, true);
  }
  if ((price * limit) / 1_000_000n > MAX_CUSTOM_FEE_LAMPORTS) return "a priority fee over 0.01 SOL";
  return null;
}
