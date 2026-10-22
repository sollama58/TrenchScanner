import { createLogger } from "@trenchscanner/core";
import type { MatchStream } from "./matchStream.js";
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

/** How often an open socket re-checks that the key's user still has paid access. */
const ACCESS_RECHECK_MS = 60_000;

interface Client {
  socket: AlertSocket;
  userId: string;
  walletAddress: string;
  /** When the upgrade was accepted. Alerts created before this are not sent. */
  openedAt: number;
}

/**
 * Pushes curated alerts that arrive after a client connects.
 *
 * Subscribed to the API's existing curated NOTIFY (MatchStream.onCuratedAlertId). A notification
 * is an id; the alert is loaded and sent once. Nothing is read on connect, and an id whose row
 * is older than the socket is dropped, so a late or repeated NOTIFY is not a backlog. Match
 * notifications never reach this class.
 *
 * Access is checked again before each send and on a timer. A lapsed subscription closes the
 * socket. The payload is never written to the log.
 */
export class ModelAlertHub {
  private readonly clients = new Set<Client>();
  private readonly stopListening: () => void;
  private readonly timer: NodeJS.Timeout;

  constructor(
    matchStream: MatchStream,
    private readonly load: (alertId: string) => Promise<LoadedModelAlert | null>,
    private readonly allowed: (walletAddress: string) => Promise<boolean>,
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

  /** Registers a socket that has already passed the key and access checks. */
  connect(socket: AlertSocket, client: Omit<Client, "socket">): void {
    const row: Client = { socket, ...client };
    this.clients.add(row);
    const drop = () => this.clients.delete(row);
    socket.on("close", drop);
    socket.on("error", drop);
  }

  /** Closes every socket and stops listening. Safe to call more than once. */
  stop(): void {
    this.stopListening();
    clearInterval(this.timer);
    for (const client of this.clients) this.close(client, 1001, "going_away");
    this.clients.clear();
  }

  private close(client: Client, code: number, reason: string): void {
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

    const text = JSON.stringify(loaded.message);
    const byWallet = new Map<string, Client[]>();
    for (const client of this.clients) {
      if (!modelAlertArrivedAfterConnect(loaded.alertedAt, client.openedAt)) continue;
      const list = byWallet.get(client.walletAddress);
      if (list) list.push(client);
      else byWallet.set(client.walletAddress, [client]);
    }

    await Promise.all(
      [...byWallet.entries()].map(async ([wallet, clients]) => {
        let ok: boolean;
        try {
          ok = await this.allowed(wallet);
        } catch (err) {
          // A failed read sends nothing. The next alert, or the timer, tries again.
          logger.warn("model alert access check failed", { error: String(err) });
          return;
        }
        if (!ok) {
          for (const client of clients) this.close(client, 4403, "access_ended");
          return;
        }
        for (const client of clients) {
          if (!modelAlertArrivedAfterConnect(loaded.alertedAt, client.openedAt)) continue;
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
      }),
    );
  }

  /** Closes sockets whose paid access has lapsed since they connected. */
  private async recheck(): Promise<void> {
    const byWallet = new Map<string, Client[]>();
    for (const client of this.clients) {
      const list = byWallet.get(client.walletAddress);
      if (list) list.push(client);
      else byWallet.set(client.walletAddress, [client]);
    }
    await Promise.all(
      [...byWallet.entries()].map(async ([wallet, clients]) => {
        try {
          if (await this.allowed(wallet)) return;
        } catch (err) {
          logger.warn("model alert access check failed", { error: String(err) });
          return;
        }
        for (const client of clients) this.close(client, 4403, "access_ended");
      }),
    );
  }
}
