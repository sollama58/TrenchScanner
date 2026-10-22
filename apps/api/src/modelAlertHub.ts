import { createLogger } from "@trenchscanner/core";
import type { MatchStream } from "./matchStream.js";
import { MAX_SOCKETS_PER_KEY, MAX_SOCKETS_PER_USER } from "./modelAlertKey.js";
import { modelAlertArrivedAfterConnect, type LoadedModelAlert } from "./modelAlertPayload.js";

/** The slice of a websocket this hub uses. OPEN is readyState 1, as in the ws library. */
interface AlertSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "close" | "error", listener: () => void): void;
}

const SOCKET_OPEN = 1;

const logger = createLogger("model-alert-socket");

/** How often an open socket re-checks that the key is still live and the user still has paid access. */
const ACCESS_RECHECK_MS = 60_000;

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

  constructor(
    matchStream: Pick<MatchStream, "onCuratedAlertId">,
    private readonly load: (alertId: string) => Promise<LoadedModelAlert | null>,
    private readonly allowed: (walletAddress: string) => Promise<boolean>,
    /** Ids in this set are still unrevoked. A throw sends nothing and closes nothing. */
    private readonly activeKeys: (keyIds: readonly string[]) => Promise<ReadonlySet<string>>,
    intervalMs = ACCESS_RECHECK_MS,
  ) {
    this.stopListening = matchStream.onCuratedAlertId((alertId) => {
      void this.publish(alertId);
    });
    this.timer = setInterval(() => {
      void this.recheck();
    }, intervalMs);
    this.timer.unref?.();
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

    const row: Client = { socket, ...client, closed: false };
    this.clients.add(row);
    const drop = () => {
      row.closed = true;
      this.clients.delete(row);
    };
    socket.on("close", drop);
    socket.on("error", drop);
    return "ok";
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
   * receive. A failed read sends nothing and closes nothing: the next alert, or the timer,
   * tries again. Revocation is checked first, so a revoked key closes even when the
   * subscription is still live.
   */
  private async enforce(clients: Client[]): Promise<Client[]> {
    const open = clients.filter((client) => !client.closed && this.clients.has(client));
    if (open.length === 0) return [];

    let live: ReadonlySet<string>;
    try {
      live = await this.activeKeys([...new Set(open.map((client) => client.keyId))]);
    } catch (err) {
      logger.warn("model alert key check failed", { error: String(err) });
      return [];
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
          if (await this.allowed(wallet)) return group.filter((client) => !client.closed);
        } catch (err) {
          logger.warn("model alert access check failed", { error: String(err) });
          return [];
        }
        for (const client of group) this.close(client, 4403, "access_ended");
        return [];
      }),
    );
    return groups.flat();
  }
}
