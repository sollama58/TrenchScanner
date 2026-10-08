import { Client } from "pg";
import {
  createLogger,
  MATCH_CHANNEL,
  CURATED_CHANNEL,
  type MatchNotification,
  type CuratedAlertNotification,
} from "@trenchscanner/core";

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
 *
 * The default is sized from what a stream actually costs, measured rather than guessed: 1200 open
 * streams moved the API's RSS by 75MB, so ~64KB each once the socket buffers are really in use.
 * 2000 is therefore on the order of 130MB, which fits beside a ~100-190MB baseline on a 512MB
 * instance. (A smaller sample suggests ~37KB; the larger, more pessimistic figure is the one to
 * size against.)
 *
 * Capacity is why this moved at all. The old 500 was a hard ceiling at roughly 250 concurrent
 * PumpTok readers, because a reader watching both sources opens two streams. Running out is
 * silent from the user's side - they simply stop getting nudges and fall back to polling - so the
 * ceiling wants to sit well above expected traffic rather than near it.
 *
 * Configurable because the right number depends on the instance: raise it on a larger plan, lower
 * it if streams are ever found to be the thing exhausting memory.
 */
const MAX_SUBSCRIBERS = Math.max(1, Number(process.env.MAX_STREAM_SUBSCRIBERS ?? 2000) || 2000);
/**
 * Open streams one user may hold across both kinds - a few tabs and devices. Without it, one
 * account could open the whole process-wide ceiling and push everyone else onto polling.
 */
const MAX_STREAMS_PER_USER = 8;

/**
 * How long one stream is held before the server ends it. Access is checked only when a stream
 * opens, so without this a stream outlived sign-out, a revoked device or a revoked subscription
 * for as long as the tab stayed open. The client reopens it within seconds (see useNudgeStream),
 * and the reopen goes through the same session and subscriber checks as any other request.
 */
const MAX_STREAM_AGE_MS = 10 * 60_000;

/** Shown in pg_stat_activity for the LISTEN session. */
export const LISTEN_APPLICATION_NAME = "trenchscanner-api-listen";

/** Backoff between reconnection attempts for the LISTEN connection, capped. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * How long opening the LISTEN connection, or any query on it, may take before it is given up on.
 *
 * pg's default for both is "forever". A connect that never completes (a TLS handshake or startup
 * to a database mid-restart) parked the stream with no client and no retry scheduled - the retry
 * is only armed once the attempt fails - so pushes stayed off until the API itself restarted.
 */
const LISTEN_TIMEOUT_MS = 10_000;

export interface StreamSink {
  write(chunk: string, callback?: (err?: Error | null) => void): boolean;
  end(): void;
  /** Node's ServerResponse exposes this; it is the only reliable "the peer is gone" signal here. */
  readonly destroyed?: boolean;
  readonly writableEnded?: boolean;
}

interface Subscriber {
  /**
   * "match" subscribers receive only their own user's matches; "curated" subscribers receive
   * every curated alert - the feed is the same for all subscribers by design, so there is
   * nothing per-user to leak.
   */
  kind: "match" | "curated";
  /** Only meaningful for kind "match". */
  userId: string;
  sink: StreamSink;
  /** When it was opened (ms), for MAX_STREAM_AGE_MS. */
  openedAt: number;
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
  /** Work to run on this instance when a curated alert is announced - see onCuratedAlert. */
  private readonly curatedListeners = new Set<() => void>();
  /** Work to run on this instance when a match is announced, given its user - see onMatch. */
  private readonly matchListeners = new Set<(userId: string) => void>();
  private client: Client | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelay = RECONNECT_BASE_MS;
  private stopped = false;
  private pinging = false;

  /**
   * `maxSubscribers` is injectable so the capacity behaviour can be tested at a small number
   * rather than by opening two thousand sockets.
   */
  constructor(
    private readonly databaseUrl: string,
    private readonly maxSubscribers: number = MAX_SUBSCRIBERS,
    /** Injectable for the same reason: so the dead-connection test needn't wait ten seconds. */
    private readonly timeoutMs: number = LISTEN_TIMEOUT_MS,
    /** Injectable so the expiry test needn't wait ten minutes. */
    private readonly maxStreamAgeMs: number = MAX_STREAM_AGE_MS,
  ) {}

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
    this.heartbeat ??= setInterval(() => {
      this.sendHeartbeat();
      void this.checkConnection();
    }, HEARTBEAT_MS);
    // Unref'd so an idle timer never by itself keeps the process alive during shutdown.
    this.heartbeat.unref?.();
    void this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.client) return;
    const client = new Client({
      connectionString: this.databaseUrl,
      connectionTimeoutMillis: this.timeoutMs,
      query_timeout: this.timeoutMs,
      // So a socket the liveness check below has already abandoned is also reaped by the OS
      // instead of lingering for the kernel's two-hour default.
      keepAlive: true,
      keepAliveInitialDelayMillis: HEARTBEAT_MS,
      // Makes this session findable in pg_stat_activity (and lets the tests terminate it).
      application_name: LISTEN_APPLICATION_NAME,
    });

    client.on("notification", (msg) => {
      if (!msg.payload) return;
      if (msg.channel === MATCH_CHANNEL) this.dispatch(msg.payload);
      else if (msg.channel === CURATED_CHANNEL) this.dispatchCurated(msg.payload);
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
      await client.query(`LISTEN ${CURATED_CHANNEL}`);
      // stop() may have run while those awaits were outstanding - a window seconds wide when the
      // database is slow or briefly unreachable at boot, which is exactly when a shutdown is
      // likely. Without this the process ends up stopped with a fully open, LISTENing connection
      // in hand and nothing left that would close it: stop() has already run, the reconnect path
      // no-ops once stopped, and Fastify's onClose hook has already been awaited.
      if (this.stopped) {
        await client.end().catch(() => {});
        return;
      }
      this.client = client;
      this.reconnectDelay = RECONNECT_BASE_MS;
      logger.info("listening for match + curated notifications", {
        channels: [MATCH_CHANNEL, CURATED_CHANNEL],
      });
    } catch (err) {
      logger.warn("failed to open listen connection", { error: String(err) });
      await client.end().catch(() => {});
      this.scheduleReconnect();
    }
  }

  /**
   * Proves the LISTEN connection still reaches a live server; called on every heartbeat.
   *
   * A listening session only ever receives, so a connection that died without a FIN or RST - the
   * database host restarted or moved, a NAT entry expired - raises no error and no "end": it
   * just goes quiet, /health/stream keeps reporting connected, and every push is lost until the
   * API restarts. A query is the only thing that notices, so one is sent on a schedule and its
   * timeout is treated as the connection being gone.
   */
  async checkConnection(): Promise<void> {
    const client = this.client;
    if (!client || this.pinging) return;
    this.pinging = true;
    try {
      await client.query("SELECT 1");
    } catch (err) {
      logger.warn("listen connection failed its liveness check", { error: String(err) });
      this.handleDisconnect(client);
    } finally {
      this.pinging = false;
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

    // Before the nudge, for the same reason dispatchCurated() runs its listeners first: the
    // client this wakes refetches at once, and must not be answered from a cache filled before
    // the match existed.
    for (const listener of this.matchListeners) {
      try {
        listener(notification.userId);
      } catch (err) {
        logger.warn("match notification listener failed", { error: String(err) });
      }
    }

    // Scoped to the owning user. A match belongs to one user's filter, and leaking another user's
    // alerts - even just their existence and timing - is not something a stream should ever do.
    const frame = `event: match\ndata: ${JSON.stringify({ matchId: notification.matchId })}\n\n`;
    for (const subscriber of this.subscribers) {
      if (subscriber.kind !== "match" || subscriber.userId !== notification.userId) continue;
      this.writeTo(subscriber, frame);
    }
  }

  /**
   * Fans one curated-alert NOTIFY out to every curated subscriber - broadcast on purpose, the
   * feed is identical for everyone behind the paywall. Same nudge-only contract as dispatch():
   * the payload carries just the id, the client refetches the feed.
   */
  dispatchCurated(payload: string): void {
    let notification: CuratedAlertNotification;
    try {
      notification = JSON.parse(payload) as CuratedAlertNotification;
    } catch {
      logger.warn("ignoring unparseable curated alert notification");
      return;
    }
    if (!notification?.alertId) return;

    // Before the nudge goes out, not after: the clients this wakes will refetch within
    // milliseconds, and this instance holds a few seconds of cached feed pages. Serving those
    // the pre-alert rows made the push pointless - the new card then waited out the client's
    // 30-second fallback poll, which is the latency the stream exists to remove. Under
    // continuous polling by several subscribers the cache is warm nearly all the time, so this
    // was the common case rather than a rare one.
    for (const listener of this.curatedListeners) {
      try {
        listener();
      } catch (err) {
        logger.warn("curated notification listener failed", { error: String(err) });
      }
    }

    const frame = `event: curated\ndata: ${JSON.stringify({ alertId: notification.alertId })}\n\n`;
    for (const subscriber of this.subscribers) {
      if (subscriber.kind !== "curated") continue;
      this.writeTo(subscriber, frame);
    }
  }

  /**
   * Registers a connected client. Returns a disposer the route must call when the request ends -
   * without it a closed tab would leave a dead subscriber accumulating heartbeat writes forever.
   * Returns null when the process is already at its subscriber ceiling.
   */
  subscribe(userId: string, sink: StreamSink): (() => void) | null {
    if (!this.hasRoomFor(userId)) return null;
    const subscriber: Subscriber = { kind: "match", userId, sink, openedAt: Date.now() };
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  /**
   * Runs `listener` whenever a curated alert is announced, before the SSE frames go out.
   *
   * For work that has to happen on this instance the moment a new alert exists rather than on a
   * client's schedule - the feed's page cache invalidating itself is the motivating case. Kept
   * separate from subscribe() because these are not stream clients: nothing is written to them
   * and they are not subject to the subscriber cap.
   */
  onCuratedAlert(listener: () => void): () => void {
    this.curatedListeners.add(listener);
    return () => this.curatedListeners.delete(listener);
  }

  /** As onCuratedAlert(), for a match: called with the user it belongs to, before their nudge. */
  onMatch(listener: (userId: string) => void): () => void {
    this.matchListeners.add(listener);
    return () => this.matchListeners.delete(listener);
  }

  /** Same contract as subscribe(), for the broadcast curated feed - shares the same capacity cap. */
  subscribeCurated(userId: string, sink: StreamSink): (() => void) | null {
    if (!this.hasRoomFor(userId)) return null;
    const subscriber: Subscriber = { kind: "curated", userId, sink, openedAt: Date.now() };
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  private hasRoomFor(userId: string): boolean {
    if (this.subscribers.size >= this.maxSubscribers) return false;
    let mine = 0;
    for (const subscriber of this.subscribers) if (subscriber.userId === userId) mine += 1;
    return mine < MAX_STREAMS_PER_USER;
  }

  /** Exposed alongside dispatch so the dead-connection sweep can be exercised without waiting 25s. */
  sendHeartbeat(): void {
    // An SSE comment: ignored by EventSource, but it is real traffic on the socket, which is what
    // both the proxy and the dead-connection check need.
    const now = Date.now();
    for (const subscriber of this.subscribers) {
      if (now - subscriber.openedAt >= this.maxStreamAgeMs) {
        // Past its age: ended so the client's reopen re-checks its access (MAX_STREAM_AGE_MS).
        this.subscribers.delete(subscriber);
        try {
          subscriber.sink.end();
        } catch {
          // Already closed - nothing to do.
        }
        continue;
      }
      this.writeTo(subscriber, ": ping\n\n");
    }
  }

  private writeTo(subscriber: Subscriber, frame: string): void {
    const { sink } = subscriber;
    // Checked up front because writing to an already-destroyed response does NOT throw - it
    // returns normally and reports the failure asynchronously. Relying on the catch below alone
    // meant a subscriber whose socket had gone was never actually swept out by this path.
    if (sink.destroyed || sink.writableEnded) {
      this.subscribers.delete(subscriber);
      return;
    }
    try {
      // The callback is what turns an async write failure into a drop. Passing one also stops
      // Node treating the error as unhandled on the response stream.
      sink.write(frame, (err) => {
        if (err) this.subscribers.delete(subscriber);
      });
    } catch {
      // Belt and braces: a sink that does throw synchronously still gets dropped.
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
    // Bounded: end() waits for the server to close its side, which a dead peer never does, and
    // shutdown has a deadline of its own to keep.
    if (client) {
      await Promise.race([
        client.end().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, this.timeoutMs).unref?.()),
      ]);
    }
  }
}
