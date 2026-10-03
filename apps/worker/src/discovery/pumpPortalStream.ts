import { createLogger, looksLikeSolanaAddress } from "@trenchscanner/core";

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

  constructor(
    private readonly url: string,
    /** Null = no WebSocket available (the stream stays off). Defaults to the runtime's global. */
    private readonly ctor: WebSocketCtor | null = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket ??
      null,
  ) {}

  /** Opens the connection. A no-op (logged once) when the runtime has no WebSocket. */
  start(): void {
    if (!this.ctor) {
      logger.warn("no WebSocket in this runtime (Node 22+ needed) - live discovery stream disabled");
      return;
    }
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
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
  handleMessage(raw: string): void {
    const event = parsePumpPortalMessage(raw);
    if (!event) return;
    // A graduation outranks a creation for the same mint - it's the newer, stronger signal.
    const existing = this.buffer.get(event.mintAddress);
    if (existing?.kind === "migrate" && event.kind === "create") return;
    if (!existing && this.buffer.size >= MAX_BUFFERED) return;
    this.buffer.set(event.mintAddress, event);
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
    socket.addEventListener("open", () => {
      this.backoffMs = MIN_BACKOFF_MS;
      // One connection, both subscriptions - PumpPortal asks clients not to open one per topic.
      socket.send(JSON.stringify({ method: "subscribeNewToken" }));
      socket.send(JSON.stringify({ method: "subscribeMigration" }));
      logger.info("stream connected");
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data === "string") this.handleMessage(event.data);
    });
    socket.addEventListener("error", () => {
      // The close event that follows carries the reconnect; logging here would double up.
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = null;
      if (!this.stopped) this.scheduleReconnect();
    });
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
