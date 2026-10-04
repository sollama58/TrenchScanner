import {
  createLogger,
  looksLikeSolanaAddress,
  TradeFlowBook,
  type FlowLaunch,
  type FlowTrade,
  type TradeFlowFeatures,
} from "@trenchscanner/core";

const logger = createLogger("pumpportal-stream");

/**
 * A live feed of Pump.fun launches and graduations from PumpPortal's public data websocket
 * (https://pumpportal.fun/data-api/real-time). Polling the newest-mints page once a minute sees a
 * launch up to a minute late and never sees a graduation at all; this stream sees both as they
 * land on chain.
 *
 * It only BUFFERS: the scan cycle drains it (see runScanCycle), so new mints enter the watchlist
 * on the same path every other discovery source uses, and a graduation puts an already-known
 * mint back in front of the scan. Like every discovery source here it is best-effort - a dropped
 * connection reconnects with backoff, a malformed message is skipped, and nothing upstream of
 * the buffer can fail a scan.
 *
 * With trade flow on, it also follows the trades of every new launch and of every mint the scan
 * asks about (watch), into a TradeFlowBook the scan reads features from (curation/tradeFlow.ts).
 * Launches that never take off, and idle mints, are dropped and unsubscribed.
 */

export interface StreamEvent {
  kind: "create" | "migrate";
  mintAddress: string;
  symbol?: string;
  name?: string;
  at: Date;
}

/** Enough to cover a burst between two scan cycles without letting a stalled scan grow it forever. */
const MAX_BUFFERED = 5_000;
const MIN_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 5 * 60_000;

/** The subset of a PumpPortal message this reads. Field names are PumpPortal's own. */
interface PumpPortalMessage {
  mint?: unknown;
  txType?: unknown;
  name?: unknown;
  symbol?: unknown;
  traderPublicKey?: unknown;
  solAmount?: unknown;
  tokenAmount?: unknown;
  initialBuy?: unknown;
  newTokenBalance?: unknown;
  marketCapSol?: unknown;
}

/** Subscription batches - PumpPortal takes a key list per subscribe message. */
const SUBSCRIBE_CHUNK = 100;
const FLUSH_INTERVAL_MS = 2_000;
const EVICT_INTERVAL_MS = 60_000;
/** Silence after which the connection is presumed dead - see checkIdle. */
const IDLE_TIMEOUT_MS = 90_000;
const IDLE_CHECK_INTERVAL_MS = 15_000;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** A trade or launch for the flow book, from an already-parsed message; null for anything else. */
export function parseFlowMessage(
  msg: PumpPortalMessage,
  at: number,
): { trade: FlowTrade } | { launch: FlowLaunch } | null {
  if (typeof msg.mint !== "string" || !looksLikeSolanaAddress(msg.mint)) return null;
  const wallet = typeof msg.traderPublicKey === "string" ? msg.traderPublicKey : undefined;
  if (msg.txType === "create") {
    return {
      launch: {
        mint: msg.mint,
        creator: wallet,
        initialBuyTokens: num(msg.initialBuy),
        initialBuySol: num(msg.solAmount),
        marketCapSol: num(msg.marketCapSol),
        at,
      },
    };
  }
  if ((msg.txType === "buy" || msg.txType === "sell") && wallet) {
    const sol = num(msg.solAmount);
    if (sol === undefined || sol < 0) return null;
    return {
      trade: {
        mint: msg.mint,
        wallet,
        side: msg.txType,
        sol,
        tokenAmount: num(msg.tokenAmount),
        newTokenBalance: num(msg.newTokenBalance),
        marketCapSol: num(msg.marketCapSol),
        at,
      },
    };
  }
  return null;
}

/** Turns one raw websocket message into an event, or null for anything that isn't one. */
export function parsePumpPortalMessage(raw: string, at: Date = new Date()): StreamEvent | null {
  let msg: PumpPortalMessage;
  try {
    msg = JSON.parse(raw) as PumpPortalMessage;
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null) return null;
  if (typeof msg.mint !== "string" || !looksLikeSolanaAddress(msg.mint)) return null;
  const kind = msg.txType === "create" ? "create" : msg.txType === "migrate" ? "migrate" : null;
  if (!kind) return null;
  return {
    kind,
    mintAddress: msg.mint,
    symbol: typeof msg.symbol === "string" ? msg.symbol.slice(0, 40) : undefined,
    name: typeof msg.name === "string" ? msg.name.slice(0, 120) : undefined,
    at,
  };
}

/** The constructor slice of the WebSocket global this needs - injectable for tests. */
type WebSocketCtor = new (url: string) => WebSocket;

export class PumpPortalStream {
  private readonly buffer = new Map<string, StreamEvent>();
  private socket: WebSocket | null = null;
  private backoffMs = MIN_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Null when trade flow is off. */
  readonly book: TradeFlowBook | null;
  private pendingSubscribe = new Set<string>();
  private timers: ReturnType<typeof setInterval>[] = [];
  /** When the current socket last opened or delivered a message - see checkIdle. */
  private lastActivityAt = 0;

  constructor(
    private readonly url: string,
    /** Null = no WebSocket available (the stream stays off). Defaults to the runtime's global. */
    private readonly ctor: WebSocketCtor | null = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket ??
      null,
    opts: { tradeFlow?: boolean } = {},
  ) {
    this.book = opts.tradeFlow === false ? null : new TradeFlowBook();
  }

  /** The scan's interest: follow these mints' trades while it keeps asking. */
  watch(mints: readonly string[]): void {
    if (!this.book) return;
    for (const mint of this.book.watch(mints, Date.now())) this.pendingSubscribe.add(mint);
  }

  /** The order-flow features for a mint right now, or undefined when trade flow is off. */
  tradeFlow(mint: string): TradeFlowFeatures | undefined {
    return this.book?.features(mint, Date.now());
  }

  /** Opens the connection. A no-op (logged once) when the runtime has no WebSocket. */
  start(): void {
    if (!this.ctor) {
      logger.warn("no WebSocket in this runtime (Node 22+ needed) - live discovery stream disabled");
      return;
    }
    this.stopped = false;
    this.connect();
    this.timers.push(setInterval(() => this.checkIdle(), IDLE_CHECK_INTERVAL_MS));
    if (this.book) {
      this.timers.push(setInterval(() => this.flushSubscriptions(), FLUSH_INTERVAL_MS));
      this.timers.push(setInterval(() => this.evict(), EVICT_INTERVAL_MS));
    }
    for (const t of this.timers) t.unref?.();
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
  }

  /** Everything buffered since the last drain, oldest first, and empties the buffer. */
  drain(): StreamEvent[] {
    const events = [...this.buffer.values()];
    this.buffer.clear();
    return events;
  }

  /** Visible for tests: what an incoming message does. */
  handleMessage(raw: string, at: number = Date.now()): void {
    if (this.book) {
      let msg: PumpPortalMessage;
      try {
        msg = JSON.parse(raw) as PumpPortalMessage;
      } catch {
        return;
      }
      const flow = typeof msg === "object" && msg !== null ? parseFlowMessage(msg, at) : null;
      if (flow && "trade" in flow) {
        this.book.trade(flow.trade);
        return;
      }
      if (flow && "launch" in flow && this.book.launch(flow.launch)) this.subscribeNow(flow.launch.mint);
    }
    const event = parsePumpPortalMessage(raw, new Date(at));
    if (!event) return;
    // A graduation outranks a creation for the same mint - it's the newer, stronger signal.
    const existing = this.buffer.get(event.mintAddress);
    if (existing?.kind === "migrate" && event.kind === "create") return;
    if (!existing && this.buffer.size >= MAX_BUFFERED) return;
    this.buffer.set(event.mintAddress, event);
  }

  /**
   * Replaces a connection that has gone quiet. Reconnecting used to hang off the close event
   * alone, and a half-open TCP connection (or a server that stops sending) never fires one - so
   * discovery and trade flow went silently dead until the worker restarted. Launches arrive every
   * few seconds, so this long with nothing, or a connect that never completes, is a dead socket.
   * Visible for tests.
   */
  checkIdle(now: number = Date.now()): void {
    const socket = this.socket;
    if (!socket || this.stopped || now - this.lastActivityAt < IDLE_TIMEOUT_MS) return;
    logger.warn("stream silent, reconnecting", { silentForMs: now - this.lastActivityAt });
    this.socket = null;
    try {
      socket.close();
    } catch {
      // Already closing - it is being dropped either way.
    }
    this.scheduleReconnect();
  }

  private connect(): void {
    let socket: WebSocket;
    try {
      socket = new this.ctor!(this.url);
    } catch (err) {
      logger.warn("could not open stream", { error: String(err) });
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.lastActivityAt = Date.now();
    socket.addEventListener("open", () => {
      this.lastActivityAt = Date.now();
      // One connection, both subscriptions - PumpPortal asks clients not to open one per topic.
      socket.send(JSON.stringify({ method: "subscribeNewToken" }));
      socket.send(JSON.stringify({ method: "subscribeMigration" }));
      // A fresh connection has no trade subscriptions: everything tracked goes back on the list.
      if (this.book) for (const mint of this.book.trackedMints()) this.pendingSubscribe.add(mint);
      logger.info("stream connected");
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      if (this.socket === socket) {
        this.lastActivityAt = Date.now();
        // Reset on a delivered message, not on open: a server that accepts and then drops us
        // straight away (a rate limit or ban) would otherwise be redialled every two seconds.
        this.backoffMs = MIN_BACKOFF_MS;
      }
      if (typeof event.data === "string") this.handleMessage(event.data);
    });
    socket.addEventListener("error", () => {
      // The close event that follows carries the reconnect; logging here would double up.
    });
    socket.addEventListener("close", () => {
      // A socket checkIdle already replaced closing late must not start a second connection.
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  /**
   * A new launch's trades are subscribed to at once rather than on the next flush: its first
   * seconds are the snipers and bundles the early-buyer and first-25 features exist to see, and
   * waiting up to FLUSH_INTERVAL_MS for the batch missed them. Queued when the socket isn't open.
   */
  private subscribeNow(mint: string): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) {
      this.pendingSubscribe.add(mint);
      return;
    }
    socket.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [mint] }));
  }

  /** Sends queued trade subscriptions, in chunks. Kept queued while disconnected. */
  flushSubscriptions(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1 || this.pendingSubscribe.size === 0) return;
    const keys = [...this.pendingSubscribe].filter((m) => this.book?.has(m));
    this.pendingSubscribe.clear();
    for (let i = 0; i < keys.length; i += SUBSCRIBE_CHUNK) {
      socket.send(
        JSON.stringify({ method: "subscribeTokenTrade", keys: keys.slice(i, i + SUBSCRIBE_CHUNK) }),
      );
    }
  }

  private evict(): void {
    if (!this.book) return;
    const dropped = this.book.evict(Date.now());
    for (const m of dropped) this.pendingSubscribe.delete(m);
    const socket = this.socket;
    if (dropped.length === 0 || !socket || socket.readyState !== 1) return;
    for (let i = 0; i < dropped.length; i += SUBSCRIBE_CHUNK) {
      socket.send(
        JSON.stringify({ method: "unsubscribeTokenTrade", keys: dropped.slice(i, i + SUBSCRIBE_CHUNK) }),
      );
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);
    logger.warn("stream disconnected, reconnecting", { inMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
