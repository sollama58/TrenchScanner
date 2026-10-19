import { apiUsageMeter } from "../apiUsage.js";
import { createLogger } from "../logger.js";
import type { ChainTx } from "../wallets/tradeTape.js";

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
 * trust the stream for everything since, and anything else it polls as before. A "tx" key whose
 * accounts change keeps its old subscription until the new one is confirmed, so the accounts in
 * both keep their cover (audit 2026-10-19: a top-25 list changing by one holder restarted all 25
 * accounts' cover, and the holder-transfer reads they were meant to spare stayed at their cap). A dropped
 * connection reconnects with backoff and every subscription starts over, so a gap reads as not
 * covered, never as no activity.
 *
 * In core so the API can follow curves too: the token chart's live tail (apps/api/src/liveCurve.ts).
 * And their trades (user ask 2026-10-19: the token page's live trades): a "logs" key follows the
 * logs of every transaction that mentions its one account (logsSubscribe, ~6 KB a trade), which
 * carry the swap events core's pumpTradeEvents.ts reads (apps/api/src/liveTrades.ts).
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
/** Most transaction keys followed at once: the contenders, with room to spare. */
const MAX_KEYS = 200;
/** Most account keys followed at once: the young coins' curves (CURVE_TAPE_MAX_MINTS caps it lower). */
const MAX_ACCOUNT_KEYS = 1_000;
/**
 * Most logs keys followed at once: the coins whose trades someone is watching, two keys each (its
 * curve and its pool; liveTrades.ts follows at most 50 coins).
 */
const MAX_LOGS_KEYS = 100;

const MAX_KEYS_OF: Record<StreamKind, number> = {
  tx: MAX_KEYS,
  account: MAX_ACCOUNT_KEYS,
  logs: MAX_LOGS_KEYS,
};

/** Helius bills 2 credits per 0.1 MB streamed. */
export function streamCredits(bytes: number): number {
  return Math.round((bytes / 100_000) * 2 * 10) / 10;
}

type WebSocketCtor = new (url: string) => WebSocket;

/**
 * What a key follows: "tx", the transactions touching its accounts (transactionSubscribe);
 * "account", its one account's data on every change (accountSubscribe, the worker's
 * jobs/curveTape.ts); or "logs", the logs of each successful transaction that mentions its one
 * account (logsSubscribe, the API's liveTrades.ts).
 */
export type StreamKind = "tx" | "account" | "logs";

interface Subscription {
  kind: StreamKind;
  accounts: ReadonlySet<string>;
  /** The request id the subscribe went out under, until Helius answers it. */
  requestId: number | null;
  /** Helius's subscription id, once it answered. */
  subId: number | null;
  /** When Helius confirmed it, ms epoch: the start of its cover. */
  since: number | null;
  wantedAt: number;
  /** Accounts covered since before `since`, by the subscription this one replaced ("tx" keys). */
  carried: Map<string, number>;
  /** The subscription this one replaced, kept live until this one is confirmed ("tx" keys). */
  retiring: Subscription | null;
}

export interface HeliusStreamStats {
  /** 1 while the connection is open, else 0. */
  connected: number;
  subscriptions: number;
  txs: number;
  /** Live account subscriptions (the curve tape's). */
  accountSubscriptions: number;
  /** Account updates delivered (the curve tape's), in the same bytes and credits. */
  accountUpdates: number;
  /**
   * Live logs subscriptions (the live trades'). Always set by takeStats; optional so the stubs
   * written before the "logs" kind still type.
   */
  logsSubscriptions?: number;
  /** Transactions' logs delivered (the live trades'), in the same bytes and credits. */
  logsUpdates?: number;
  /**
   * Reconnects scheduled (a close, a failed open, or a silent socket replaced), and silent sockets
   * replaced (checkIdle). Always set by takeStats; optional for the older stubs.
   */
  reconnects?: number;
  stalls?: number;
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
  /**
   * Subscribes in flight for keys since dropped or replaced, with the method that undoes them:
   * sent as soon as Helius answers.
   */
  private readonly abandonedRequests = new Map<number, string>();
  private nextId = 1;
  private backoffMs = MIN_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private stopped = false;
  private lastActivityAt = 0;
  private stats = {
    txs: 0,
    accountUpdates: 0,
    logsUpdates: 0,
    bytes: 0,
    connections: 0,
    reconnects: 0,
    stalls: 0,
  };
  /** Silence after which nothing counts as covered (stallAfter); null: only the reconnect's timeout. */
  private coverStallMs: number | null = null;
  /** The feature this socket's credits go under in ApiUsage (metered); null leaves them out. */
  private meterFeature: string | null = null;
  /** Credits counted but not yet a whole one: ApiUsage keeps whole credits. */
  private meterPending = 0;

  constructor(
    private readonly url: string,
    /** Each transaction delivered, with the key whose accounts it touched. */
    private readonly onTx: (key: string, signature: string, tx: ChainTx) => void,
    private readonly ctor: WebSocketCtor | null = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket ??
      null,
    /**
     * Each account update delivered for an "account" key: its base64 data, the message's size and
     * the slot it was read at (pairs two accounts changed by one transaction: liveCurve.ts's pools).
     */
    private readonly onAccount:
      ((key: string, data: string, bytes: number, slot: number | null) => void) | null = null,
    /**
     * Each successful transaction's logs delivered for a "logs" key, with its signature, the
     * message's size and its slot. Failed transactions are dropped here: they traded nothing.
     */
    private readonly onLogs:
      | ((key: string, signature: string, logs: string[], bytes: number, slot: number | null) => void)
      | null = null,
  ) {}

  /**
   * Counts this socket's bytes and connections as Helius credits in Admin > API usage, under
   * `feature` (endpoint "websocket"): the meter only sees fetch, so a socket's spend was missing
   * there and showed only in a since-boot estimate a deploy resets (audit 2026-10-19).
   */
  metered(feature: string): this {
    this.meterFeature = feature;
    return this;
  }

  /**
   * Treats `ms` without a word from Helius (the slot feed speaks every ~0.4 s) as a stall for cover:
   * coveredSince answers null until the socket speaks again, so the caller reads by RPC at once,
   * though the reconnect itself still waits for IDLE_TIMEOUT_MS. For the chart's live tail (audit
   * 2026-10-19, item 3): a silent socket served frozen prices as "Live" for up to ~75 s.
   */
  stallAfter(ms: number): this {
    this.coverStallMs = ms;
    return this;
  }

  /**
   * How long the open socket has been silent past stallAfter's limit (ms), or 0 while it speaks,
   * is not open, or no limit was set.
   */
  stalledForMs(now: number = Date.now()): number {
    if (this.coverStallMs === null || this.socket?.readyState !== 1) return 0;
    const silent = now - this.lastActivityAt;
    return silent >= this.coverStallMs ? silent : 0;
  }

  private meter(bytes: number, connections: number): void {
    if (this.meterFeature === null) return;
    this.meterPending += (bytes / 100_000) * 2 + connections;
    const credits = Math.floor(this.meterPending);
    this.meterPending -= credits;
    apiUsageMeter.add(
      Date.now(),
      this.meterFeature,
      { provider: "helius", endpoint: "websocket", calls: bytes > 0 ? 1 : 0, credits },
      { requests: 0, ok: true, rateLimited: false, ms: 0 },
    );
  }

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
  watch(key: string, accounts: readonly string[], now = Date.now(), kind: StreamKind = "tx"): void {
    if (accounts.length === 0 || (kind !== "tx" && accounts.length !== 1)) return;
    const existing = this.subs.get(key);
    if (existing && existing.kind === kind && sameSet(existing.accounts, accounts)) {
      existing.wantedAt = now;
      return;
    }
    if (!existing && this.countOf(kind) >= MAX_KEYS_OF[kind]) return;
    const sub: Subscription = {
      kind,
      accounts: new Set(accounts),
      requestId: null,
      subId: null,
      since: null,
      wantedAt: now,
      carried: new Map(),
      retiring: null,
    };
    if (existing) {
      // Make before break: the live subscription keeps covering the accounts both follow until the
      // new one is confirmed, and they carry their cover over to it.
      const live =
        kind === "tx" && existing.kind === "tx"
          ? existing.since !== null
            ? existing
            : existing.retiring?.since != null
              ? existing.retiring
              : null
          : null;
      if (live) {
        for (const a of sub.accounts) {
          if (live.accounts.has(a)) sub.carried.set(a, live.carried.get(a) ?? live.since!);
        }
        sub.retiring = live;
      }
      if (existing !== live) this.unsubscribe(key, existing, live);
    }
    this.subs.set(key, sub);
    this.subscribe(key, sub);
  }

  /** Stops following `key` now, rather than when it is next evicted. */
  unwatch(key: string): void {
    const sub = this.subs.get(key);
    if (!sub) return;
    this.unsubscribe(key, sub);
    this.subs.delete(key);
  }

  private countOf(kind: StreamKind): number {
    let n = 0;
    for (const sub of this.subs.values()) if (sub.kind === kind) n += 1;
    return n;
  }

  /**
   * Undoes `key`'s subscription and asks for it again with the same accounts: its cover starts over
   * once Helius confirms the new one. For a caller that found the stream silently missing an
   * account's changes (liveCurve.ts checks covered accounts by RPC).
   */
  resubscribe(key: string): void {
    const sub = this.subs.get(key);
    if (!sub) return;
    this.unsubscribe(key, sub);
    this.subscribe(key, sub);
  }

  /**
   * From when `account` has been followed under `key` without a break (ms epoch), or null when it
   * is not followed right now (or the socket is stalled: stallAfter).
   */
  coveredSince(key: string, account: string, now: number = Date.now()): number | null {
    const sub = this.subs.get(key);
    if (!sub || !sub.accounts.has(account) || this.socket?.readyState !== 1) return null;
    if (this.stalledForMs(now) > 0) return null;
    if (sub.since !== null) return sub.carried.get(account) ?? sub.since;
    // The replaced subscription, until this one is confirmed, for the accounts both follow.
    const old = sub.retiring;
    if (old?.since == null || !old.accounts.has(account)) return null;
    return old.carried.get(account) ?? old.since;
  }

  /** Counts since the last call, for the scan's heartbeat. */
  takeStats(): HeliusStreamStats {
    const out: HeliusStreamStats = {
      connected: this.socket?.readyState === 1 ? 1 : 0,
      subscriptions: [...this.subs.values()].filter((s) => s.kind === "tx" && s.since !== null).length,
      accountSubscriptions: this.liveCount("account"),
      logsSubscriptions: this.liveCount("logs"),
      txs: this.stats.txs,
      accountUpdates: this.stats.accountUpdates,
      logsUpdates: this.stats.logsUpdates,
      bytes: this.stats.bytes,
      credits: streamCredits(this.stats.bytes) + this.stats.connections,
      reconnects: this.stats.reconnects,
      stalls: this.stats.stalls,
    };
    this.stats = {
      txs: 0,
      accountUpdates: 0,
      logsUpdates: 0,
      bytes: 0,
      connections: 0,
      reconnects: 0,
      stalls: 0,
    };
    return out;
  }

  /** Subscriptions of `kind` Helius has confirmed. */
  private liveCount(kind: StreamKind): number {
    let n = 0;
    for (const sub of this.subs.values()) if (sub.kind === kind && sub.since !== null) n += 1;
    return n;
  }

  /** Visible for tests: what one message from Helius does. */
  handleMessage(raw: string, at: number = Date.now()): void {
    this.stats.bytes += raw.length;
    this.meter(raw.length, 0);
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
      const undo = this.abandonedRequests.get(msg.id);
      if (undo !== undefined) {
        this.abandonedRequests.delete(msg.id);
        if (typeof msg.result === "number") this.sendUnsubscribe(msg.result, undo);
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
        if (sub.retiring) {
          this.unsubscribe(key, sub.retiring);
          sub.retiring = null;
        }
      } else {
        // Kept, uncovered: asked again with the same accounts it is not resent (a refusal would
        // come back every cycle), only on the next connection or when its accounts change.
        logger.warn("subscription refused", { key, error: String(msg.error?.message ?? "unknown") });
      }
      return;
    }
    if (msg.method === "accountNotification") {
      const subId = msg.params?.subscription;
      const key = typeof subId === "number" ? this.keyOfSub.get(subId) : undefined;
      const result = msg.params?.result as
        { context?: { slot?: unknown }; value?: { data?: unknown } } | undefined;
      const data = result?.value?.data;
      if (key === undefined || !Array.isArray(data) || typeof data[0] !== "string") return;
      this.stats.accountUpdates += 1;
      const slot = typeof result?.context?.slot === "number" ? result.context.slot : null;
      try {
        this.onAccount?.(key, data[0], raw.length, slot);
      } catch (err) {
        logger.warn("stream account handler failed", { key, error: String(err) });
      }
      return;
    }
    if (msg.method === "logsNotification") {
      const subId = msg.params?.subscription;
      const key = typeof subId === "number" ? this.keyOfSub.get(subId) : undefined;
      const result = msg.params?.result as
        | { context?: { slot?: unknown }; value?: { signature?: unknown; err?: unknown; logs?: unknown } }
        | undefined;
      const value = result?.value;
      if (key === undefined || typeof value?.signature !== "string" || !Array.isArray(value.logs)) return;
      this.stats.logsUpdates += 1;
      if (value.err !== null && value.err !== undefined) return;
      const slot = typeof result?.context?.slot === "number" ? result.context.slot : null;
      try {
        this.onLogs?.(key, value.signature, value.logs as string[], raw.length, slot);
      } catch (err) {
        logger.warn("stream logs handler failed", { key, error: String(err) });
      }
      return;
    }
    if (msg.method !== "transactionNotification") return;
    const subId = msg.params?.subscription;
    const key = typeof subId === "number" ? this.keyOfSub.get(subId) : undefined;
    const result = msg.params?.result;
    if (key === undefined || typeof result?.signature !== "string") return;
    const tx = streamTx(result.transaction);
    if (!tx) return;
    this.stats.txs += 1;
    try {
      this.onTx(key, result.signature, tx);
    } catch (err) {
      logger.warn("stream transaction handler failed", { key, error: String(err) });
    }
  }

  /** Replaces a connection that has gone quiet. Visible for tests. */
  checkIdle(now: number = Date.now()): void {
    const socket = this.socket;
    if (!socket || this.stopped || now - this.lastActivityAt < IDLE_TIMEOUT_MS) return;
    logger.warn("stream silent, reconnecting", { silentForMs: now - this.lastActivityAt });
    this.stats.stalls += 1;
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
      this.meter(0, 1);
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
      sub.carried.clear();
      sub.retiring = null;
    }
  }

  private subscribe(key: string, sub: Subscription): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return;
    const id = this.nextId++;
    sub.requestId = id;
    this.keyOfRequest.set(id, key);
    if (sub.kind === "account") {
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "accountSubscribe",
          params: [[...sub.accounts][0], { commitment: "confirmed", encoding: "base64" }],
        }),
      );
      return;
    }
    if (sub.kind === "logs") {
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "logsSubscribe",
          params: [{ mentions: [[...sub.accounts][0]] }, { commitment: "confirmed" }],
        }),
      );
      return;
    }
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

  /** Undoes `sub`, and the subscription it was replacing unless that is `keep`. */
  private unsubscribe(key: string, sub: Subscription, keep: Subscription | null = null): void {
    if (sub.retiring && sub.retiring !== keep) this.unsubscribe(key, sub.retiring);
    sub.retiring = null;
    sub.carried.clear();
    if (sub.requestId !== null) {
      this.keyOfRequest.delete(sub.requestId);
      this.abandonedRequests.set(sub.requestId, unsubscribeMethod(sub.kind));
      sub.requestId = null;
    }
    if (sub.subId !== null) {
      this.keyOfSub.delete(sub.subId);
      this.sendUnsubscribe(sub.subId, unsubscribeMethod(sub.kind));
    }
    sub.subId = null;
    sub.since = null;
    logger.debug("unsubscribed", { key });
  }

  private sendUnsubscribe(subId: number, method: string): void {
    const socket = this.socket;
    if (socket?.readyState !== 1) return;
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextId++,
        method,
        params: [subId],
      }),
    );
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);
    this.stats.reconnects += 1;
    logger.warn("stream disconnected, reconnecting", { inMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

/**
 * A notification's transaction in the shape the chain readers take (core's ChainTx), or null.
 * With transactionDetails "accounts" the RPC puts the account keys on the transaction itself
 * ({ signatures, accountKeys }) rather than under `message`, where keysOf looks for them.
 */
export function streamTx(raw: unknown): ChainTx | null {
  if (typeof raw !== "object" || raw === null) return null;
  const tx = raw as ChainTx & { transaction?: { accountKeys?: unknown } };
  const inner = tx.transaction;
  if (inner && !inner.message && Array.isArray(inner.accountKeys)) {
    const { accountKeys, ...rest } = inner;
    return {
      ...tx,
      transaction: { ...rest, message: { accountKeys: accountKeys as (string | { pubkey?: string })[] } },
    };
  }
  return tx;
}

function unsubscribeMethod(kind: StreamKind): string {
  return kind === "account"
    ? "accountUnsubscribe"
    : kind === "logs"
      ? "logsUnsubscribe"
      : "transactionUnsubscribe";
}

function sameSet(a: ReadonlySet<string>, b: readonly string[]): boolean {
  if (a.size !== new Set(b).size) return false;
  return b.every((x) => a.has(x));
}
