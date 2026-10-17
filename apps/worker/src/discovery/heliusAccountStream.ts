import { createLogger, type ChainTx } from "@trenchscanner/core";

const logger = createLogger("helius-stream");

/**
 * Helius's enhanced websocket (transactionSubscribe, Developer plan and up), following the
 * transactions that touch a set of accounts instead of re-reading their signatures on a timer
 * (user ask 2026-10-17: Helius credits). One subscription per key (a coin), over that key's
 * accounts (its top holders' token accounts); a key's subscription is replaced when its account
 * list changes, and dropped once nobody has asked for it for UNWATCHED_TTL_MS.
 *
 * Streaming bills by size (2 credits per 0.1 MB, 1 per connection), not per call. Holder token
 * accounts only move when their holder trades or sends the coin, so this is a trickle: the bytes
 * received are counted (takeStats) so the heartbeat shows what it really costs.
 *
 * Nothing waits on it. `coveredSince` says from when a key's accounts have been followed without
 * a break; a caller that read an account itself after that (with STREAM_SETTLE_MS to spare) can
 * trust the stream for everything since, and anything else it polls as before. A dropped
 * connection reconnects with backoff and every subscription starts over, so a gap reads as not
 * covered, never as no activity.
 */

/** Silence after which the connection is presumed dead: the slot subscription speaks every ~0.4 s. */
const IDLE_TIMEOUT_MS = 60_000;
const IDLE_CHECK_INTERVAL_MS = 15_000;
const EVICT_INTERVAL_MS = 60_000;
/** A key nobody has asked for in this long is unsubscribed. */
export const UNWATCHED_TTL_MS = 15 * 60_000;
const MIN_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 5 * 60_000;
/**
 * How long after a subscription starts an account must have been read for the stream to cover it:
 * a transaction confirmed just before the subscription is live is not sent, and a read made right
 * after can still miss it while it is unfinalized.
 */
export const STREAM_SETTLE_MS = 30_000;
/** Most keys followed at once: the contenders, with room to spare. */
const MAX_KEYS = 200;

/** Helius bills 2 credits per 0.1 MB streamed. */
export function streamCredits(bytes: number): number {
  return Math.round((bytes / 100_000) * 2 * 10) / 10;
}

type WebSocketCtor = new (url: string) => WebSocket;

interface Subscription {
  accounts: ReadonlySet<string>;
  /** The request id the subscribe went out under, until Helius answers it. */
  requestId: number | null;
  /** Helius's subscription id, once it answered. */
  subId: number | null;
  /** When Helius confirmed it, ms epoch: the start of its cover. */
  since: number | null;
  wantedAt: number;
}

export interface HeliusStreamStats {
  /** 1 while the connection is open, else 0. */
  connected: number;
  subscriptions: number;
  txs: number;
  bytes: number;
  /** Estimated from the bytes received (streamCredits), plus one per connection opened. */
  credits: number;
}

export class HeliusAccountStream {
  private socket: WebSocket | null = null;
  private readonly subs = new Map<string, Subscription>();
  /** Helius's subscription id to the key it follows. */
  private readonly keyOfSub = new Map<number, string>();
  /** Request ids of subscribes in flight to their key. */
  private readonly keyOfRequest = new Map<number, string>();
  /** Subscribes in flight for keys since dropped or replaced: undone as soon as Helius answers. */
  private readonly abandonedRequests = new Set<number>();
  private nextId = 1;
  private backoffMs = MIN_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private stopped = false;
  private lastActivityAt = 0;
  private stats = { txs: 0, bytes: 0, connections: 0 };

  constructor(
    private readonly url: string,
    /** Each transaction delivered, with the key whose accounts it touched. */
    private readonly onTx: (key: string, signature: string, tx: ChainTx) => void,
    private readonly ctor: WebSocketCtor | null = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket ??
      null,
  ) {}

  static urlFor(apiKey: string): string {
    return `wss://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
  }

  start(): void {
    if (!this.ctor) {
      logger.warn("no WebSocket in this runtime (Node 22+ needed) - Helius stream disabled");
      return;
    }
    this.stopped = false;
    this.connect();
    this.timers.push(setInterval(() => this.checkIdle(), IDLE_CHECK_INTERVAL_MS));
    this.timers.push(setInterval(() => this.evict(), EVICT_INTERVAL_MS));
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

  /** Follow `accounts` under `key` while asked (again at least every UNWATCHED_TTL_MS). */
  watch(key: string, accounts: readonly string[], now = Date.now()): void {
    if (accounts.length === 0) return;
    const existing = this.subs.get(key);
    if (existing && sameSet(existing.accounts, accounts)) {
      existing.wantedAt = now;
      return;
    }
    if (!existing && this.subs.size >= MAX_KEYS) return;
    if (existing) this.unsubscribe(key, existing);
    const sub: Subscription = {
      accounts: new Set(accounts),
      requestId: null,
      subId: null,
      since: null,
      wantedAt: now,
    };
    this.subs.set(key, sub);
    this.subscribe(key, sub);
  }

  /**
   * From when `account` has been followed under `key` without a break (ms epoch), or null when it
   * is not followed right now.
   */
  coveredSince(key: string, account: string): number | null {
    const sub = this.subs.get(key);
    if (!sub || sub.since === null || !sub.accounts.has(account)) return null;
    return this.socket?.readyState === 1 ? sub.since : null;
  }

  /** Counts since the last call, for the scan's heartbeat. */
  takeStats(): HeliusStreamStats {
    const out: HeliusStreamStats = {
      connected: this.socket?.readyState === 1 ? 1 : 0,
      subscriptions: [...this.subs.values()].filter((s) => s.since !== null).length,
      txs: this.stats.txs,
      bytes: this.stats.bytes,
      credits: streamCredits(this.stats.bytes) + this.stats.connections,
    };
    this.stats = { txs: 0, bytes: 0, connections: 0 };
    return out;
  }

  /** Visible for tests: what one message from Helius does. */
  handleMessage(raw: string, at: number = Date.now()): void {
    this.stats.bytes += raw.length;
    let msg: {
      id?: unknown;
      result?: unknown;
      error?: { message?: unknown };
      method?: unknown;
      params?: { subscription?: unknown; result?: { signature?: unknown; transaction?: unknown } };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    if (typeof msg.id === "number") {
      if (this.abandonedRequests.delete(msg.id)) {
        if (typeof msg.result === "number") this.sendUnsubscribe(msg.result);
        return;
      }
      const key = this.keyOfRequest.get(msg.id);
      if (key === undefined) return;
      this.keyOfRequest.delete(msg.id);
      const sub = this.subs.get(key);
      if (!sub || sub.requestId !== msg.id) return;
      sub.requestId = null;
      if (typeof msg.result === "number") {
        sub.subId = msg.result;
        sub.since = at;
        this.keyOfSub.set(msg.result, key);
      } else {
        logger.warn("subscription refused", { key, error: String(msg.error?.message ?? "unknown") });
        this.subs.delete(key);
      }
      return;
    }
    if (msg.method !== "transactionNotification") return;
    const subId = msg.params?.subscription;
    const key = typeof subId === "number" ? this.keyOfSub.get(subId) : undefined;
    const result = msg.params?.result;
    if (key === undefined || typeof result?.signature !== "string") return;
    const tx = result.transaction;
    if (typeof tx !== "object" || tx === null) return;
    this.stats.txs += 1;
    try {
      this.onTx(key, result.signature, tx as ChainTx);
    } catch (err) {
      logger.warn("stream transaction handler failed", { key, error: String(err) });
    }
  }

  /** Replaces a connection that has gone quiet. Visible for tests. */
  checkIdle(now: number = Date.now()): void {
    const socket = this.socket;
    if (!socket || this.stopped || now - this.lastActivityAt < IDLE_TIMEOUT_MS) return;
    logger.warn("stream silent, reconnecting", { silentForMs: now - this.lastActivityAt });
    this.dropSocket(socket);
    this.scheduleReconnect();
  }

  /** Unsubscribes the keys nobody has asked for lately. Visible for tests. */
  evict(now: number = Date.now()): void {
    for (const [key, sub] of this.subs) {
      if (now - sub.wantedAt < UNWATCHED_TTL_MS) continue;
      this.unsubscribe(key, sub);
      this.subs.delete(key);
    }
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
      this.stats.connections += 1;
      // The slot feed keeps the connection busy (Helius closes one idle for 10 minutes) and is the
      // heartbeat checkIdle watches; it costs a few hundred credits a day.
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "slotSubscribe" }));
      for (const [key, sub] of this.subs) this.subscribe(key, sub);
      logger.info("stream connected", { keys: this.subs.size });
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      if (this.socket !== socket) return;
      this.lastActivityAt = Date.now();
      this.backoffMs = MIN_BACKOFF_MS;
      if (typeof event.data === "string") this.handleMessage(event.data);
    });
    socket.addEventListener("error", () => {
      // The close event that follows carries the reconnect.
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.dropSocket(socket);
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  /** Forgets a connection and with it every subscription's cover: they start over on the next one. */
  private dropSocket(socket: WebSocket): void {
    if (this.socket === socket) this.socket = null;
    try {
      socket.close();
    } catch {
      // Already closing.
    }
    this.keyOfSub.clear();
    this.keyOfRequest.clear();
    this.abandonedRequests.clear();
    for (const sub of this.subs.values()) {
      sub.subId = null;
      sub.requestId = null;
      sub.since = null;
    }
  }

  private subscribe(key: string, sub: Subscription): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return;
    const id = this.nextId++;
    sub.requestId = id;
    this.keyOfRequest.set(id, key);
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "transactionSubscribe",
        params: [
          { accountInclude: [...sub.accounts], vote: false, failed: false },
          {
            commitment: "confirmed",
            encoding: "jsonParsed",
            // Account keys and balances, without instructions or logs: all a transfer read needs.
            transactionDetails: "accounts",
            showRewards: false,
            maxSupportedTransactionVersion: 0,
          },
        ],
      }),
    );
  }

  private unsubscribe(key: string, sub: Subscription): void {
    if (sub.requestId !== null) {
      this.keyOfRequest.delete(sub.requestId);
      this.abandonedRequests.add(sub.requestId);
      sub.requestId = null;
    }
    if (sub.subId !== null) {
      this.keyOfSub.delete(sub.subId);
      this.sendUnsubscribe(sub.subId);
    }
    sub.subId = null;
    sub.since = null;
    logger.debug("unsubscribed", { key });
  }

  private sendUnsubscribe(subId: number): void {
    const socket = this.socket;
    if (socket?.readyState !== 1) return;
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "transactionUnsubscribe",
        params: [subId],
      }),
    );
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

function sameSet(a: ReadonlySet<string>, b: readonly string[]): boolean {
  if (a.size !== new Set(b).size) return false;
  return b.every((x) => a.has(x));
}
