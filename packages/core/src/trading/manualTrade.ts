import { TransientError } from "./errors.js";
import { NoRouteError, RateLimitedError, WSOL_MINT, type SwapQuote } from "./jupiterSwap.js";
import {
  curveQuoteToken,
  curveRefusal,
  curveTokensOut,
  parsePumpCurve,
  pumpBuyInstructions,
  pumpCurveAddress,
  pumpBuybackRecipient,
  pumpBuybackRecipients,
  pumpSellInstructions,
  PUMP_GLOBAL,
  type PumpCurve,
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
  associatedTokenAddress,
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
  getMintInfo(mint: string): Promise<{ program: string; decimals?: number; transferFeeBps?: number } | null>;
  getPriorityFeeEstimate(accounts: string[]): Promise<bigint | null>;
}

export interface ManualTradeJupiter {
  quote(input: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
    restrictIntermediateTokens?: boolean;
    maxAccounts?: number;
    onlyDirectRoutes?: boolean;
  }): Promise<SwapQuote>;
  swapInstructions(input: { quote: SwapQuote; userPublicKey: string; useTokenLedger?: boolean }): Promise<{
    instructions: InstructionSpec[];
    lookupTables: string[];
    computeUnitLimit: number | null;
    ledgerAt?: number;
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
  /**
   * A curve quoted in another coin: that coin's mint. The transaction swaps SOL to it with Jupiter
   * and buys on the curve with it (a sale: sells on the curve, then swaps all it paid back to SOL).
   */
  via?: string;
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
/**
 * Room under a buy for the rent of the accounts it opens, and base fees. A first buy through a
 * coin quoted in another coin opens up to four: the token's account (~0.0015 SOL), one for each
 * hop's coin (~0.0015 SOL each) and Pump's volume trackers (~0.0013 SOL each) - 0.0059 SOL on a
 * 0.25 SOL buy refused on mainnet (2026-10-19) under the 0.005 this was. Still a hard ceiling:
 * the route can't take more than this beyond the buy and its fees.
 */
const BUY_MARGIN_LAMPORTS = 10_000_000n;
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
/** The same, swapping what a token ledger measured (a curve sale's quote coin), with the same tail. */
const JUPITER_LEDGER_ROUTES = new Set(["route_with_token_ledger", "shared_accounts_route_with_token_ledger"]);
/** Jupiter's set_token_ledger: records the input account's balance for the ledger route. */
export const JUPITER_SET_TOKEN_LEDGER = [228, 85, 185, 112, 78, 79, 77, 2];
/**
 * The slippage on the Jupiter half of a trade through a curve's quote coin (PUMP, USDC): those
 * pools are deep, and on a buy the curve spends that half's minimum, so whatever it delivers above
 * that stays in the wallet as the quote coin. Kept small so that remainder is small too.
 */
const HOP_SLIPPAGE_BPS = 50;
/**
 * The most accounts Jupiter's half of such a trade may name: the curve's own instruction takes 17
 * and the transaction is 1,232 bytes at most.
 */
const HOP_MAX_ACCOUNTS = 30;

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
  let via: string | undefined;
  try {
    const quote = await quoteInSol(
      deps.jupiter,
      {
        inputMint: buy ? WSOL_MINT : req.mint,
        outputMint: buy ? req.mint : WSOL_MINT,
        amount: req.amount,
        slippageBps: req.slippageBps,
      },
      // A coin still on its SOL curve trades there (below) before any open route: one through a
      // thin pool of some other token would price it off that pool, not the curve.
      async () => {
        const curve = await readCurve(deps.rpc, req.mint, deps.random);
        return !curveRefusal(curve.curve) && !!curve.curve && !!curve.buyback;
      },
    );
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
    const refusal = curveRefusal(curve.curve, { quoteToken: true });
    if (refusal || !curve.curve || !curve.buyback)
      throw err instanceof NoRouteError
        ? new TradeRejected(`no route for this token (${refusal ?? "Pump.fun's fee recipients unreadable"})`)
        : err;
    route = "pump";
    const quoteMint = curveQuoteToken(curve.curve);
    if (quoteMint) {
      // Quoted in another coin: SOL to it with Jupiter, then the curve, in one transaction.
      const hop = await buildCurveHop(deps, req, mintInfo.program, curve.curve, curve.recipients, quoteMint);
      via = quoteMint;
      ({ swapIxs, tables, units, quotedOut, minOut } = hop);
    } else {
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

  let tx: Uint8Array;
  try {
    tx = buildV0Transaction(
      req.wallet,
      blockhash.blockhash,
      [...computeBudgetInstructions(units, price), ...swapIxs, tipIx],
      resolved,
      STATIC_PROGRAMS,
    );
  } catch (err) {
    // Two swaps in one transaction leave little room: Jupiter's pool for the quote coin can be one
    // with too many accounts at times.
    if (via && err instanceof Error && /too large/.test(err.message))
      throw new TransientError(
        "the swap through this coin's quote coin didn't fit in one transaction: try again",
      );
    throw err;
  }
  const limits = {
    maxExternalLamports: tip,
    maxPriorityFeeLamports: priorityFee,
    ...(route === "jupiter" || via ? { maxSlippageBps: req.slippageBps } : {}),
    ...(via ? { via } : {}),
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
    ...(via ? { via } : {}),
    quotedOut: quotedOut.toString(),
    minOut: minOut.toString(),
    tipLamports: tip.toString(),
    priorityFeeLamports: priorityFee.toString(),
  };
}

/**
 * Jupiter's quote for a trade in SOL. A coin quoted in another coin (PUMP, USDC, another
 * memecoin) is routed through it, SOL to the quote token to the coin and back on a sale, in one
 * transaction: the trader only ever pays and receives SOL. The hops are held to Jupiter's liquid
 * tokens first; a coin whose quote token isn't one of them is asked again with any hop allowed
 * (the slippage floor and the guard still bound what the route delivers).
 */
export async function quoteInSol(
  jupiter: Pick<ManualTradeJupiter, "quote">,
  input: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number; maxAccounts?: number },
  /** True when the caller has a better route than an open one (the coin's SOL curve): no retry. */
  preferOwnRoute?: () => Promise<boolean>,
): Promise<SwapQuote> {
  try {
    return await jupiter.quote(input);
  } catch (err) {
    if (!(err instanceof NoRouteError)) throw err;
    if (preferOwnRoute && (await preferOwnRoute().catch(() => false))) throw err;
    return jupiter.quote({ ...input, restrictIntermediateTokens: false });
  }
}

/** The tokens a route passes through between SOL and the coin (its quote token, USDC...), in order. */
export function routeHopMints(quote: SwapQuote, mint: string): string[] {
  const plan = quote.routePlan;
  if (!Array.isArray(plan)) return [];
  const hops: string[] = [];
  for (const step of plan as { swapInfo?: { inputMint?: unknown; outputMint?: unknown } }[]) {
    for (const m of [step.swapInfo?.inputMint, step.swapInfo?.outputMint])
      if (typeof m === "string" && m !== WSOL_MINT && m !== mint && !hops.includes(m)) hops.push(m);
  }
  return hops;
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
  /** A ledger route (a curve sale's quote coin to SOL), with its one set_token_ledger. */
  opts: { ledger?: boolean } = {},
): void {
  const isLedger = (ix: InstructionSpec) => JUPITER_SET_TOKEN_LEDGER.every((b, i) => ix.data[i] === b);
  const jupiter = ixs.filter((ix) => ix.programId === PROGRAM.jupiterV6);
  const ledgers = jupiter.filter(isLedger);
  const routes = jupiter
    .filter((ix) => !isLedger(ix))
    .map((ix) => ({ ix, route: readJupiterRoute(Uint8Array.from(ix.data)) }));
  const read = routes.filter((r) => r.route !== null);
  const names = opts.ledger ? JUPITER_LEDGER_ROUTES : JUPITER_EXACT_IN_ROUTES;
  // Every Jupiter instruction must be the one route read here (and the ledger, when one is
  // asked for): one it can't parse goes unchecked.
  if (
    read.length !== 1 ||
    routes.length !== 1 ||
    ledgers.length !== (opts.ledger ? 1 : 0) ||
    !names.has(read[0]!.route!.name)
  )
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
  const recipients = data[1] ? pumpBuybackRecipients(data[1]) : [];
  return { curve, buyback, recipients };
}

/**
 * A trade on a curve quoted in another coin (PUMP, USDC), in SOL: the trader pays and receives
 * SOL, and the quote coin is swapped with Jupiter in the same transaction.
 *
 *   Buy:  Jupiter SOL -> quote coin, then the curve spends that swap's minimum on the coin. What
 *         the swap gives above its minimum (within HOP_SLIPPAGE_BPS) stays in the wallet as the
 *         quote coin: the curve's spend has to be fixed when the transaction is built.
 *   Sale: the curve sells the coin for the quote coin, then Jupiter swaps exactly what the sale
 *         paid back to SOL (a token-ledger route), so none of it is left over.
 *
 * Pump.fun's own multi_hop_swap covers coins quoted in a Pump.fun coin, but not PUMP or USDC
 * (it starts from a Pump.fun pool or curve), so Jupiter takes the SOL half here.
 */
async function buildCurveHop(
  deps: { rpc: ManualTradeRpc; jupiter: ManualTradeJupiter; random?: () => number },
  req: ManualTradeRequest,
  tokenProgram: string,
  curve: PumpCurve,
  recipients: string[],
  quoteMint: string,
): Promise<{
  swapIxs: InstructionSpec[];
  tables: string[];
  units: number;
  quotedOut: bigint;
  minOut: bigint;
}> {
  const quoteInfo = await deps.rpc.getMintInfo(quoteMint);
  if (!quoteInfo) throw new TransientError("couldn't read the curve's quote coin");
  if (quoteInfo.program !== PROGRAM.token && quoteInfo.program !== PROGRAM.token2022)
    throw new TradeRejected("the curve's quote coin isn't a token this can trade");
  const quote = { mint: quoteMint, program: quoteInfo.program };
  // The buyback fee is paid in the quote coin, to a recipient's account for it, which the trade
  // never creates (and the guard wouldn't let it open someone else's): one that exists already.
  const buybackAccounts = recipients.map((r) => associatedTokenAddress(r, quoteMint, quote.program));
  const existing = buybackAccounts.length > 0 ? await deps.rpc.getAccountsData(buybackAccounts) : [];
  if (!existing) throw new TransientError("couldn't read Pump.fun's fee recipients");
  const open = buybackAccounts.filter((_, i) => existing[i] !== null);
  if (open.length === 0)
    throw new TradeRejected(
      "no route for this token (Pump.fun's fee recipients have no account for its quote coin)",
    );
  const buyback = open[Math.floor((deps.random ?? Math.random)() * open.length)]!;
  const accounts = {
    wallet: req.wallet,
    mint: req.mint,
    tokenProgram,
    curve,
    buybackFeeRecipient: buyback,
    quote,
  };
  const hopSlippage = Math.min(req.slippageBps, HOP_SLIPPAGE_BPS);
  // One pool between SOL and the quote coin when there is one (the fewest accounts: the curve's
  // instruction needs room in the transaction too), else a short route.
  const hopQuote = async (input: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
  }) => {
    try {
      return await deps.jupiter.quote({ ...input, onlyDirectRoutes: true });
    } catch (err) {
      if (!(err instanceof NoRouteError)) throw err;
      return quoteInSol(deps.jupiter, { ...input, maxAccounts: HOP_MAX_ACCOUNTS });
    }
  };
  const jupiterIxs = (ixs: InstructionSpec[]) => ixs.filter((ix) => ix.programId !== PROGRAM.computeBudget);
  const unitsWith = (jupiterLimit: number | null, curveUnits: number) => {
    const limit = Math.ceil((jupiterLimit ?? DEFAULT_JUPITER_UNITS) * JUPITER_UNIT_SLACK);
    return Math.min(MAX_UNITS, Math.max(MIN_UNITS, limit + JUPITER_UNIT_EXTRA + curveUnits));
  };

  if (req.side === "buy") {
    const q = await hopQuote({
      inputMint: WSOL_MINT,
      outputMint: quoteMint,
      amount: req.amount,
      slippageBps: hopSlippage,
    });
    const built = await deps.jupiter.swapInstructions({ quote: q, userPublicKey: req.wallet });
    const swapIxs = jupiterIxs(built.instructions);
    const quoteOut = BigInt(q.outAmount);
    checkJupiterFloor(swapIxs, quoteOut, BigInt(q.otherAmountThreshold), hopSlippage);
    // What the swap is sure to deliver, rounded down (Jupiter's own threshold rounds up): the curve
    // spends no more, so it never dips into quote coin the wallet already held.
    const quoteMin = (quoteOut * BigInt(10_000 - hopSlippage)) / 10_000n;
    const b = (() => {
      try {
        return pumpBuyInstructions({ ...accounts, solIn: quoteMin, slippageBps: req.slippageBps });
      } catch (err) {
        throw new TradeRejected(err instanceof Error ? err.message : String(err));
      }
    })();
    return {
      swapIxs: [...swapIxs, ...b.instructions],
      tables: built.lookupTables,
      units: unitsWith(built.computeUnitLimit, PUMP_BUY_UNITS),
      quotedOut: curveTokensOut(curve, quoteOut),
      minOut: b.minTokens,
    };
  }

  const s = pumpSellInstructions({ ...accounts, tokens: req.amount, slippageBps: req.slippageBps });
  if (s.minSol <= 0n) throw new TradeRejected("the sale is too small to get anything back");
  const q = await hopQuote({
    inputMint: quoteMint,
    outputMint: WSOL_MINT,
    amount: s.minSol,
    slippageBps: hopSlippage,
  });
  const built = await deps.jupiter.swapInstructions({
    quote: q,
    userPublicKey: req.wallet,
    useTokenLedger: true,
  });
  const ixs = jupiterIxs(built.instructions);
  const ledgerAt = ixs.findIndex((ix) => JUPITER_SET_TOKEN_LEDGER.every((b, i) => ix.data[i] === b));
  if (built.ledgerAt === undefined || ledgerAt < 0)
    throw new GuardRefusal("Jupiter returned no token ledger");
  const quoteOut = BigInt(q.outAmount);
  const minOut = BigInt(q.otherAmountThreshold);
  checkJupiterFloor(ixs, quoteOut, minOut, hopSlippage, { ledger: true });
  // The wallet's account for the quote coin must exist before the curve pays into it.
  const openQuote: InstructionSpec = {
    programId: PROGRAM.ata,
    accounts: [
      { pubkey: req.wallet, writable: true, signer: true },
      { pubkey: associatedTokenAddress(req.wallet, quoteMint, quote.program), writable: true },
      { pubkey: req.wallet, writable: false },
      { pubkey: quoteMint, writable: false },
      { pubkey: PROGRAM.system, writable: false },
      { pubkey: quote.program, writable: false },
    ],
    data: [1], // CreateIdempotent
  };
  return {
    // The ledger records the quote coin's balance, the curve pays into it, and the route swaps
    // exactly what came in.
    swapIxs: [openQuote, ...ixs.slice(0, ledgerAt + 1), ...s.instructions, ...ixs.slice(ledgerAt + 1)],
    tables: built.lookupTables,
    units: unitsWith(null, PUMP_SELL_UNITS),
    quotedOut: (quoteOut * 10_000n) / BigInt(10_000 - req.slippageBps),
    minOut,
  };
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

/** A new token account's rent, lamports: the classic program's 165 bytes, Token-2022's with its fee extension. */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280n;
export const TOKEN_2022_ACCOUNT_RENT_LAMPORTS = 2_074_080n;

/**
 * What a route's pools charge, basis points of what goes through them: each hop's fee as a share
 * of its own side of the swap, weighted by the hop's share of the route. Null when the quote
 * doesn't say (no route plan, a hop without its fee, or no fee at all).
 */
export function routeFeeBps(quote: SwapQuote): { bps: number; venues: string[] } | null {
  const plan = quote.routePlan;
  if (!Array.isArray(plan) || plan.length === 0) return null;
  let bps = 0;
  const venues: string[] = [];
  for (const step of plan as { percent?: unknown; swapInfo?: Record<string, unknown> }[]) {
    const info = step.swapInfo;
    if (!info) return null;
    const fee = Number(info.feeAmount);
    const feeMint = info.feeMint;
    const inAmount = Number(info.inAmount);
    const outAmount = Number(info.outAmount);
    if (!Number.isFinite(fee) || fee < 0) return null;
    // A fee taken in what goes in is a share of it; one taken from what comes out, of out plus fee.
    const base = feeMint === info.inputMint ? inAmount : feeMint === info.outputMint ? outAmount + fee : NaN;
    if (!Number.isFinite(base) || base <= 0) return null;
    const share = typeof step.percent === "number" ? step.percent / 100 : 1;
    bps += (fee / base) * 10_000 * share;
    if (typeof info.label === "string" && info.label && !venues.includes(info.label)) venues.push(info.label);
  }
  // Pools nearly always charge something: a route reporting none is read as not saying.
  if (bps <= 0) return null;
  return { bps: Math.round(bps * 10) / 10, venues };
}

export interface SwapCosts {
  /** The coin's own transfer fee (Token-2022), basis points of every transfer; 0 without one, null unread. */
  transferFeeBps: number | null;
  /** The pools' fees on the route Jupiter would take now (LP, curve and protocol fees); null when unknown. */
  poolFeeBps: number | null;
  /** Where the route goes (Pump.fun, PumpSwap, Raydium...). */
  venues: string[];
  /** Price impact of the reference buy, percent; null when unknown. */
  priceImpactPct: number | null;
  /**
   * Rent for the wallet's token accounts a buy opens (refunded when they are closed): the coin's on
   * a first buy, and one for each token the route hops through that the wallet has no account
   * for yet. 0 when it has them all.
   */
  accountRentLamports: bigint;
  /** The tokens the route hops through between SOL and the coin (a non-SOL quote token, USDC...). */
  routeVia: string[];
  /** The coins the reference buy would get, raw units, by the route's quote; null without one. */
  outAmount: bigint | null;
  /** The coin's decimals; null when unread. */
  decimals: number | null;
}

/**
 * What a swap costs beyond the network fee, for the panel to show before anything is built: the
 * coin's transfer tax, the pools' fees and price impact on a reference buy, and the token
 * account's rent on a first buy. Each part that can't be read is left out, never guessed.
 */
export async function estimateSwapCosts(
  deps: {
    rpc: Pick<ManualTradeRpc, "getMintInfo" | "getAccountsData">;
    jupiter: Pick<ManualTradeJupiter, "quote">;
  },
  input: { wallet: string; mint: string; referenceLamports: bigint },
): Promise<SwapCosts> {
  const mintInfo = await deps.rpc.getMintInfo(input.mint);
  const program = mintInfo?.program ?? PROGRAM.token;
  const quote = await quoteInSol(deps.jupiter, {
    inputMint: WSOL_MINT,
    outputMint: input.mint,
    amount: input.referenceLamports,
    slippageBps: 500,
  }).catch(() => null);
  const via = quote ? routeHopMints(quote, input.mint) : [];
  const viaPrograms = await Promise.all(
    via.map((m) =>
      deps.rpc
        .getMintInfo(m)
        .then((i) => i?.program ?? null)
        .catch(() => null),
    ),
  );
  // The wallet's account for the coin, then for each hop under its token program (unread: classic).
  const owned = [
    { address: associatedTokenAddress(input.wallet, input.mint, program), program },
    ...via.map((m, i) => {
      const p = viaPrograms[i] ?? PROGRAM.token;
      return { address: associatedTokenAddress(input.wallet, m, p), program: p };
    }),
  ];
  const accounts = await deps.rpc.getAccountsData(owned.map((o) => o.address)).catch(() => null);
  const rentOf = (p: string) =>
    p === PROGRAM.token2022 ? TOKEN_2022_ACCOUNT_RENT_LAMPORTS : TOKEN_ACCOUNT_RENT_LAMPORTS;
  const route = quote ? routeFeeBps(quote) : null;
  const impact = quote ? Number(quote.priceImpactPct) * 100 : NaN;
  return {
    transferFeeBps: mintInfo ? (mintInfo.transferFeeBps ?? 0) : null,
    poolFeeBps: route?.bps ?? null,
    venues: route?.venues ?? [],
    priceImpactPct: Number.isFinite(impact) ? impact : null,
    accountRentLamports: accounts
      ? owned.reduce((sum, o, i) => (accounts[i] === null ? sum + rentOf(o.program) : sum), 0n)
      : 0n,
    routeVia: via,
    outAmount: quote && /^\d+$/.test(String(quote.outAmount)) ? BigInt(quote.outAmount) : null,
    decimals: typeof mintInfo?.decimals === "number" ? mintInfo.decimals : null,
  };
}

/**
 * The SOL a sale of `units` raw coins would get by the route Jupiter would take now, lamports,
 * before slippage; null without a route. Quoted into SOL whatever the coin's pool trades against
 * (a PUMP or USDC pair is routed on to SOL), so it reads like the Buy side's expected coins.
 */
export async function estimateSaleProceeds(
  deps: { jupiter: Pick<ManualTradeJupiter, "quote"> },
  input: { mint: string; units: bigint },
): Promise<bigint | null> {
  const quote = await quoteInSol(deps.jupiter, {
    inputMint: input.mint,
    outputMint: WSOL_MINT,
    amount: input.units,
    slippageBps: 500,
  }).catch(() => null);
  return quote && /^\d+$/.test(String(quote.outAmount)) ? BigInt(quote.outAmount) : null;
}
