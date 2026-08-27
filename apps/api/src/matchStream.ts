import { Client } from "pg";
import { createLogger, MATCH_CHANNEL, type MatchNotification } from "@trenchscanner/core";

const logger = createLogger("match-stream");

/**
 * How long a subscriber can sit silent before a comment frame is written to it. Two jobs: it keeps
 * proxies and load balancers from culling an idle connection, and it's how a client that vanished
 * without a FIN (laptop lid, dead mobile network) is detected - the write fails and the subscriber
 * is dropped.
 */
const HEARTBEAT_MS = 25_000;

/**
 * Ceiling on concurrent streams per process. Each one is an open socket held for as long as the
 * tab is; without a cap, a misbehaving or malicious client could pin file descriptors until the
 * API stops accepting connections at all. Over the cap the route falls back to telling the client
 * to poll, which is a degraded experience rather than a broken one.
 */
const MAX_SUBSCRIBERS = 500;

/** Backoff between reconnection attempts for the LISTEN connection, capped. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface StreamSink {
  write(chunk: string): boolean;
  end(): void;
}

interface Subscriber {
  userId: string;
  sink: StreamSink;
}

/**
 * Pushes newly created matches to connected dashboards the moment the worker records them.
 *
 * The worker and the API are separate processes sharing only a database, so the signal travels by
 * Postgres LISTEN/NOTIFY - no broker, no extra service. This class owns one dedicated pg connection
 * for LISTEN (it cannot be a pooled one: LISTEN registers against a specific backend session, so a
 * connection handed back to a pool stops receiving) and fans each notification out to the SSE
 * subscribers belonging to that user.
 *
 * Every API instance runs one of these. Postgres delivers a NOTIFY to all listening sessions, so
 * horizontal scaling needs nothing extra - each instance serves whichever clients it happens to
 * hold.
 *
 * NOTIFY is not durable: nothing is queued for a listener that is disconnected at that instant.
 * That is a deliberate trade rather than an oversight - the client keeps a slow fallback poll, so a
 * missed nudge costs latency, never data. It's also why the payload carries only identifiers.
 */
export class MatchStream {
  private readonly subscribers = new Set<Subscriber>();
  private client: Client | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelay = RECONNECT_BASE_MS;
  private stopped = false;

  constructor(private readonly databaseUrl: string) {}

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Whether the LISTEN connection is currently up. Surfaced on /health so a silent stream is visible. */
  get connected(): boolean {
    return this.client !== undefined;
  }

  /**
   * Opens the LISTEN connection and starts the heartbeat. Never throws: a database that is briefly
   * unreachable at boot must not stop the API from serving ordinary requests, so a failure here
   * schedules a retry instead.
   */
  start(): void {
    this.stopped = false;
    this.heartbeat ??= setInterval(() => this.sendHeartbeat(), HEARTBEAT_MS);
    // Unref'd so an idle timer never by itself keeps the process alive during shutdown.
    this.heartbeat.unref?.();
    void this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.client) return;
    const client = new Client({ connectionString: this.databaseUrl });

    client.on("notification", (msg) => {
      if (msg.channel !== MATCH_CHANNEL || !msg.payload) return;
      this.dispatch(msg.payload);
    });
    // A dropped LISTEN connection is silent by nature - no request fails, clients just stop
    // receiving - so it has to be actively noticed and rebuilt.
    client.on("error", (err) => {
      logger.warn("listen connection error", { error: String(err) });
      this.handleDisconnect(client);
    });
    client.on("end", () => this.handleDisconnect(client));

    try {
      await client.connect();
      await client.query(`LISTEN ${MATCH_CHANNEL}`);
      this.client = client;
      this.reconnectDelay = RECONNECT_BASE_MS;
      logger.info("listening for match notifications", { channel: MATCH_CHANNEL });
    } catch (err) {
      logger.warn("failed to open listen connection", { error: String(err) });
      await client.end().catch(() => {});
      this.scheduleReconnect();
    }
  }

  private handleDisconnect(client: Client): void {
    if (this.client !== client) return;
    this.client = undefined;
    void client.end().catch(() => {});
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
    logger.info("scheduled listen reconnect", { delayMs: delay });
  }

  /**
   * Fans one raw NOTIFY payload out to the subscribers it belongs to. Public because it is the
   * seam worth testing directly - everything above it is a database connection, everything below
   * it is a socket, and the routing decision in between is the part that must not be wrong.
   */
  dispatch(payload: string): void {
    let notification: MatchNotification;
    try {
      notification = JSON.parse(payload) as MatchNotification;
    } catch {
      logger.warn("ignoring unparseable match notification");
      return;
    }
    if (!notification?.userId || !notification.matchId) return;

    // Scoped to the owning user. A match belongs to one user's filter, and leaking another user's
    // alerts - even just their existence and timing - is not something a stream should ever do.
    const frame = `event: match\ndata: ${JSON.stringify({ matchId: notification.matchId })}\n\n`;
    for (const subscriber of this.subscribers) {
      if (subscriber.userId !== notification.userId) continue;
      this.writeTo(subscriber, frame);
    }
  }

  /**
   * Registers a connected client. Returns a disposer the route must call when the request ends -
   * without it a closed tab would leave a dead subscriber accumulating heartbeat writes forever.
   * Returns null when the process is already at MAX_SUBSCRIBERS.
   */
  subscribe(userId: string, sink: StreamSink): (() => void) | null {
    if (this.subscribers.size >= MAX_SUBSCRIBERS) return null;
    const subscriber: Subscriber = { userId, sink };
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  /** Exposed alongside dispatch so the dead-connection sweep can be exercised without waiting 25s. */
  sendHeartbeat(): void {
    // An SSE comment: ignored by EventSource, but it is real traffic on the socket, which is what
    // both the proxy and the dead-connection check need.
    for (const subscriber of this.subscribers) this.writeTo(subscriber, ": ping\n\n");
  }

  private writeTo(subscriber: Subscriber, frame: string): void {
    try {
      subscriber.sink.write(frame);
    } catch {
      // The peer is gone and the socket is already torn down; drop it rather than retrying.
      this.subscribers.delete(subscriber);
    }
  }

  /** Closes every stream and the LISTEN connection. Safe to call more than once. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;

    for (const subscriber of this.subscribers) {
      try {
        subscriber.sink.end();
      } catch {
        // Already closed - nothing to do.
      }
    }
    this.subscribers.clear();

    const client = this.client;
    this.client = undefined;
    if (client) await client.end().catch(() => {});
  }
}
