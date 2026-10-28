import { createLogger } from "@trenchscanner/core";
import type { MatchStream } from "./matchStream.js";
import { MAX_SOCKETS_PER_KEY, MAX_SOCKETS_PER_USER } from "./modelAlertKey.js";
import { modelAlertArrivedAfterConnect, type LoadedModelAlert } from "./modelAlertPayload.js";

/** The slice of a websocket this hub uses. OPEN is readyState 1, as in the ws library. */
interface AlertSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "close" | "error" | "pong", listener: () => void): void;
  /** A protocol ping; the client's pong comes back as a "pong" event (ws answers it on its own). */
  ping?(): void;
  /** Drops the connection without a closing handshake, for a peer that no longer answers. */
  terminate?(): void;
}

const SOCKET_OPEN = 1;

const logger = createLogger("model-alert-socket");

/** How often an open socket re-checks that the key is still live and the user still has paid access. */
const ACCESS_RECHECK_MS = 60_000;

/**
 * How often each socket is pinged. One that has not answered the previous ping by the next is
 * dropped: a half-open connection, or one an edge cut while idle, is otherwise never noticed and
 * its alerts go nowhere (audit 10-27 WB-23). Under the usual 60-100 s proxy idle cut.
 */
const PING_MS = 30_000;

/**
 * When the key or access read itself fails, a socket that passed both within this long still gets
 * the alert, instead of the alert going to nobody. Past it, the failed read sends nothing, as before.
 */
const CHECK_GRACE_MS = 90_000;

export interface ModelAlertClient {
  userId: string;
  keyId: string;
  walletAddress: string;
  /** When authentication finished. Alerts created before this are not sent. */
  openedAt: number;
}

interface Client extends ModelAlertClient {
  socket: AlertSocket;
  closed: boolean;
  /** When the key and access checks last passed for it (ms, `now()`); authentication counts. */
  checkedAt: number;
  /** Whether it answered the last ping. */
  alive: boolean;
}

export interface ModelAlertHubTiming {
  recheckMs?: number;
  pingMs?: number;
  now?: () => number;
}

/** Why connect() refused a socket. The route closes it; the hub does not keep it. */
export type ModelAlertAdmit = "ok" | "key_cap" | "user_cap";

/**
 * Pushes curated alerts that arrive after a client connects.
 *
 * Subscribed to the API's existing curated NOTIFY (MatchStream.onCuratedAlertId). A notification
 * is an id; the alert is loaded and sent once. Nothing is read on connect, and an id whose row
 * is older than the socket is dropped, so a late or repeated NOTIFY is not a backlog. Match
 * notifications never reach this class. The bytes sent are the loaded alert only. A client
 * frame is never copied into them.
 *
 * Access and the key are checked again before each send and on a timer. A lapsed subscription
 * or a revoked key closes the socket. The payload is never written to the log.
 */
export class ModelAlertHub {
  private readonly clients = new Set<Client>();
  private readonly stopListening: () => void;
  private readonly timer: NodeJS.Timeout;
  private readonly pinger: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(
    matchStream: Pick<MatchStream, "onCuratedAlertId">,
    private readonly load: (alertId: string) => Promise<LoadedModelAlert | null>,
    private readonly allowed: (walletAddress: string) => Promise<boolean>,
    /** Ids in this set are still unrevoked. A throw sends nothing and closes nothing. */
    private readonly activeKeys: (keyIds: readonly string[]) => Promise<ReadonlySet<string>>,
    { recheckMs = ACCESS_RECHECK_MS, pingMs = PING_MS, now = Date.now }: ModelAlertHubTiming = {},
  ) {
    this.now = now;
    this.stopListening = matchStream.onCuratedAlertId((alertId) => {
      void this.publish(alertId);
    });
    this.timer = setInterval(() => {
      void this.recheck();
    }, recheckMs);
    this.timer.unref?.();
    this.pinger = setInterval(() => this.pingAll(), pingMs);
    this.pinger.unref?.();
  }

  /**
   * Registers a socket that has already passed the key and access checks.
   * Refuses the socket, without adding it, when this process is already at the per-key or
   * per-user cap. The check and the add are synchronous, so two admits cannot both pass it.
   */
  connect(socket: AlertSocket, client: ModelAlertClient): ModelAlertAdmit {
    let byKey = 0;
    let byUser = 0;
    for (const existing of this.clients) {
      if (existing.keyId === client.keyId) byKey += 1;
      if (existing.userId === client.userId) byUser += 1;
    }
    if (byKey >= MAX_SOCKETS_PER_KEY) return "key_cap";
    if (byUser >= MAX_SOCKETS_PER_USER) return "user_cap";

    const row: Client = { socket, ...client, closed: false, checkedAt: this.now(), alive: true };
    this.clients.add(row);
    const drop = () => {
      row.closed = true;
      this.clients.delete(row);
    };
    socket.on("close", drop);
    socket.on("error", drop);
    socket.on("pong", () => {
      row.alive = true;
    });
    return "ok";
  }

  /** Pings every socket, and drops each that never answered the last one. */
  private pingAll(): void {
    for (const client of [...this.clients]) {
      if (client.closed) continue;
      if (!client.alive) {
        this.drop(client);
        continue;
      }
      client.alive = false;
      try {
        client.socket.ping?.();
      } catch {
        this.drop(client);
      }
    }
  }

  /** A peer that stopped answering: no closing handshake to wait on. */
  private drop(client: Client): void {
    if (client.closed) return;
    if (!client.socket.terminate) return this.close(client, 1001, "ping_timeout");
    client.closed = true;
    this.clients.delete(client);
    try {
      client.socket.terminate();
    } catch {
      // Already gone.
    }
  }

  /** Closes every socket on this process that authenticated with this key. */
  disconnectKey(keyId: string): void {
    // Copy first: close() deletes from the set, and deleting during iteration skips entries.
    for (const client of [...this.clients]) {
      if (client.keyId === keyId) this.close(client, 4401, "key_revoked");
    }
  }

  /** Closes every socket and stops listening. Safe to call more than once. */
  stop(): void {
    this.stopListening();
    clearInterval(this.timer);
    clearInterval(this.pinger);
    for (const client of [...this.clients]) this.close(client, 1001, "going_away");
    this.clients.clear();
  }

  private close(client: Client, code: number, reason: string): void {
    if (client.closed) return;
    client.closed = true;
    this.clients.delete(client);
    try {
      client.socket.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  private async publish(alertId: string): Promise<void> {
    if (this.clients.size === 0) return;
    let loaded: LoadedModelAlert | null;
    try {
      loaded = await this.load(alertId);
    } catch (err) {
      logger.warn("model alert load failed", { error: String(err) });
      return;
    }
    if (!loaded) return;
    const alert = loaded;

    const due = [...this.clients].filter(
      (client) => !client.closed && modelAlertArrivedAfterConnect(alert.alertedAt, client.openedAt),
    );
    if (due.length === 0) return;

    const allowed = await this.enforce(due);
    // The alert object alone. Nothing the client sent is concatenated in.
    const text = JSON.stringify(alert.message);
    for (const client of allowed) {
      if (client.closed || !this.clients.has(client)) continue;
      if (!modelAlertArrivedAfterConnect(alert.alertedAt, client.openedAt)) continue;
      if (client.socket.readyState !== SOCKET_OPEN) {
        this.clients.delete(client);
        continue;
      }
      try {
        client.socket.send(text);
      } catch (err) {
        logger.warn("model alert send failed", { error: String(err) });
        this.clients.delete(client);
      }
    }
  }

  /** Closes sockets whose key was revoked or whose paid access has lapsed. */
  private async recheck(): Promise<void> {
    if (this.clients.size === 0) return;
    await this.enforce([...this.clients]);
  }

  /**
   * Drops revoked keys and lapsed subscriptions from `clients` and returns who may still
   * receive. A failed read closes nothing, and sends only to the clients that passed both checks
   * within CHECK_GRACE_MS (so one failed read no longer drops an alert for everyone); the next
   * alert, or the timer, tries again. Revocation is checked first, so a revoked key closes even
   * when the subscription is still live.
   */
  private async enforce(clients: Client[]): Promise<Client[]> {
    const open = clients.filter((client) => !client.closed && this.clients.has(client));
    if (open.length === 0) return [];
    const startedAt = this.now();
    const recent = (group: Client[]) =>
      group.filter((client) => !client.closed && startedAt - client.checkedAt <= CHECK_GRACE_MS);

    let live: ReadonlySet<string>;
    try {
      live = await this.activeKeys([...new Set(open.map((client) => client.keyId))]);
    } catch (err) {
      logger.warn("model alert key check failed", { error: String(err) });
      return recent(open);
    }

    const keyed: Client[] = [];
    for (const client of open) {
      if (client.closed) continue;
      if (live.has(client.keyId)) keyed.push(client);
      else this.close(client, 4401, "key_revoked");
    }

    const byWallet = new Map<string, Client[]>();
    for (const client of keyed) {
      const list = byWallet.get(client.walletAddress);
      if (list) list.push(client);
      else byWallet.set(client.walletAddress, [client]);
    }

    const groups = await Promise.all(
      [...byWallet.entries()].map(async ([wallet, group]) => {
        try {
          if (await this.allowed(wallet)) {
            const passed = group.filter((client) => !client.closed);
            for (const client of passed) client.checkedAt = startedAt;
            return passed;
          }
        } catch (err) {
          logger.warn("model alert access check failed", { error: String(err) });
          return recent(group);
        }
        for (const client of group) this.close(client, 4403, "access_ended");
        return [];
      }),
    );
    return groups.flat();
  }
}
