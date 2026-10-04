// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { createServer, connect, type Socket } from "node:net";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import type { FastifyInstance } from "fastify";
import { MATCH_CHANNEL, loadEnv, prisma } from "@trenchscanner/core";
import { LISTEN_APPLICATION_NAME, MatchStream, type StreamSink } from "./matchStream.js";
import { buildServer } from "./server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "./auth/session.js";

/**
 * Collects what would have gone down the socket.
 *
 * `destroyed` is how a real peer disappearance actually presents: Node's ServerResponse.write()
 * to a torn-down socket returns normally and reports the failure through its callback - it does
 * NOT throw. An earlier version of this fake threw synchronously, which made the drop-dead-
 * subscriber test pass against behaviour that never happens in production. `throws` is kept as a
 * separate mode purely to cover the belt-and-braces catch.
 */
function sink(options: { destroyed?: boolean; asyncError?: boolean; throws?: boolean } = {}) {
  const written: string[] = [];
  let ended = false;
  const s: StreamSink = {
    destroyed: options.destroyed ?? false,
    writableEnded: false,
    write(chunk, callback) {
      if (options.throws) throw new Error("EPIPE");
      if (options.asyncError) {
        callback?.(new Error("EPIPE"));
        return false;
      }
      written.push(chunk);
      callback?.(null);
      return true;
    },
    end() {
      ended = true;
    },
  };
  return {
    sink: s,
    written,
    get ended() {
      return ended;
    },
  };
}

/** Never started, so no database connection is opened - dispatch is pure fan-out. */
const stream = () => new MatchStream("postgresql://unused");

const notification = (userId: string, matchId = "m1") => JSON.stringify({ userId, matchId });

describe("MatchStream.dispatch", () => {
  it("delivers a match only to the user it belongs to", () => {
    // A match belongs to one user's filter. Leaking another user's alerts - even just their
    // existence and timing - is not something a stream should ever do.
    const s = stream();
    const alice = sink();
    const bob = sink();
    s.subscribe("alice", alice.sink);
    s.subscribe("bob", bob.sink);

    s.dispatch(notification("alice", "match-1"));

    expect(alice.written).toEqual(['event: match\ndata: {"matchId":"match-1"}\n\n']);
    expect(bob.written).toEqual([]);
  });

  it("delivers to every one of a user's open tabs", () => {
    const s = stream();
    const tabOne = sink();
    const tabTwo = sink();
    s.subscribe("alice", tabOne.sink);
    s.subscribe("alice", tabTwo.sink);

    s.dispatch(notification("alice"));

    expect(tabOne.written).toHaveLength(1);
    expect(tabTwo.written).toHaveLength(1);
  });

  it("ignores an unparseable payload rather than throwing into the pg callback", () => {
    const s = stream();
    const alice = sink();
    s.subscribe("alice", alice.sink);

    expect(() => s.dispatch("not json")).not.toThrow();
    expect(() => s.dispatch(JSON.stringify({ userId: "alice" }))).not.toThrow();
    expect(() => s.dispatch(JSON.stringify({ matchId: "m1" }))).not.toThrow();
    expect(alice.written).toEqual([]);
  });

  it("drops a subscriber whose response is already destroyed", () => {
    // A client that vanished without a FIN (laptop lid, dead mobile network). Writing to it does
    // not throw, so the destroyed flag is the only thing that catches this.
    const s = stream();
    s.subscribe("alice", sink({ destroyed: true }).sink);
    expect(s.subscriberCount).toBe(1);

    s.dispatch(notification("alice"));

    expect(s.subscriberCount).toBe(0);
  });

  it("drops a subscriber whose write fails asynchronously", () => {
    // The other real shape: the socket looked fine at write time and the error arrives via the
    // callback. Passing a callback is also what stops Node treating it as an unhandled error.
    const s = stream();
    s.subscribe("alice", sink({ asyncError: true }).sink);

    s.dispatch(notification("alice"));

    expect(s.subscriberCount).toBe(0);
  });

  it("still drops a sink that throws synchronously", () => {
    const s = stream();
    s.subscribe("alice", sink({ throws: true }).sink);

    s.dispatch(notification("alice"));

    expect(s.subscriberCount).toBe(0);
  });

  it("stops delivering once the subscriber is disposed", () => {
    const s = stream();
    const alice = sink();
    const dispose = s.subscribe("alice", alice.sink);
    dispose?.();

    s.dispatch(notification("alice"));

    expect(alice.written).toEqual([]);
    expect(s.subscriberCount).toBe(0);
  });
});

describe("MatchStream capacity", () => {
  it("refuses new subscribers past the cap instead of pinning unbounded sockets", () => {
    // The cap is injected rather than read from the module constant, so this asserts the
    // behaviour - refuse past the ceiling - and not whatever the ceiling currently happens to be.
    const s = new MatchStream("postgresql://unused", 3);
    const accepted = [
      s.subscribe("a", sink().sink),
      s.subscribe("b", sink().sink),
      s.subscribe("c", sink().sink),
    ];

    expect(accepted.every((d) => d !== null)).toBe(true);
    expect(s.subscribe("one-too-many", sink().sink)).toBe(null);
  });

  it("counts curated subscribers against the same ceiling as match subscribers", () => {
    // They share one pool: a reader watching both sources holds two of these, which is exactly
    // why the ceiling had to move.
    const s = new MatchStream("postgresql://unused", 2);

    expect(s.subscribe("a", sink().sink)).not.toBe(null);
    expect(s.subscribeCurated("u", sink().sink)).not.toBe(null);
    expect(s.subscribeCurated("u", sink().sink)).toBe(null);
  });

  it("caps how many streams one user can hold, across both kinds", () => {
    const s = new MatchStream("postgresql://unused", 100);
    for (let i = 0; i < 4; i++) {
      expect(s.subscribe("greedy", sink().sink)).not.toBe(null);
      expect(s.subscribeCurated("greedy", sink().sink)).not.toBe(null);
    }
    expect(s.subscribe("greedy", sink().sink)).toBe(null);
    expect(s.subscribeCurated("greedy", sink().sink)).toBe(null);
    expect(s.subscribe("someone-else", sink().sink)).not.toBe(null);
  });
});

describe("MatchStream.sendHeartbeat", () => {
  it("writes a comment frame that EventSource ignores but the socket does not", () => {
    const s = stream();
    const alice = sink();
    s.subscribe("alice", alice.sink);

    s.sendHeartbeat();

    expect(alice.written).toEqual([": ping\n\n"]);
  });

  it("sweeps out subscribers whose socket died between events", () => {
    const s = stream();
    s.subscribe("alice", sink({ destroyed: true }).sink);

    s.sendHeartbeat();

    expect(s.subscriberCount).toBe(0);
  });
});

describe("MatchStream.stop", () => {
  it("closes every open stream", async () => {
    const s = stream();
    const alice = sink();
    s.subscribe("alice", alice.sink);

    await s.stop();

    expect(alice.ended).toBe(true);
    expect(s.subscriberCount).toBe(0);
  });
});

describe("MatchStream.dispatchCurated", () => {
  it("broadcasts a curated alert to every curated subscriber and no match subscriber", () => {
    const s = stream();
    const curatedA = sink();
    const curatedB = sink();
    const matchSub = sink();
    s.subscribeCurated("u", curatedA.sink);
    s.subscribeCurated("u", curatedB.sink);
    s.subscribe("alice", matchSub.sink);

    s.dispatchCurated(JSON.stringify({ alertId: "alert-1" }));

    const frame = 'event: curated\ndata: {"alertId":"alert-1"}\n\n';
    expect(curatedA.written).toEqual([frame]);
    expect(curatedB.written).toEqual([frame]);
    // A match subscriber's stream carries only that user's matches - curated traffic has its own
    // endpoint, and mixing them would surprise every existing client.
    expect(matchSub.written).toEqual([]);
  });

  it("keeps match traffic off curated streams", () => {
    const s = stream();
    const curated = sink();
    s.subscribeCurated("u", curated.sink);

    s.dispatch(notification("alice", "match-1"));

    expect(curated.written).toEqual([]);
  });

  it("ignores unparseable and id-less curated payloads", () => {
    const s = stream();
    const curated = sink();
    s.subscribeCurated("u", curated.sink);

    s.dispatchCurated("{not json");
    s.dispatchCurated(JSON.stringify({}));

    expect(curated.written).toEqual([]);
  });

  it("disposes a curated subscriber cleanly", () => {
    const s = stream();
    const curated = sink();
    const dispose = s.subscribeCurated("u", curated.sink)!;
    dispose();

    s.dispatchCurated(JSON.stringify({ alertId: "alert-1" }));

    expect(curated.written).toEqual([]);
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

/** Polls until `check` holds, so the tests wait on the real reconnect rather than a fixed sleep. */
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * A TCP relay in front of Postgres that can go silent without closing anything - what a database
 * host that vanished mid-connection looks like from this side: no FIN, no RST, just no replies.
 */
async function silentableRelay(databaseUrl: string) {
  const target = new URL(databaseUrl);
  const sockets: Socket[] = [];
  const pairs: [Socket, Socket][] = [];
  const server = createServer((downstream) => {
    const upstream = connect(Number(target.port || 5432), target.hostname);
    downstream.pipe(upstream);
    upstream.pipe(downstream);
    downstream.on("error", () => {});
    upstream.on("error", () => {});
    sockets.push(downstream, upstream);
    pairs.push([downstream, upstream]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const relayed = new URL(databaseUrl);
  relayed.hostname = "127.0.0.1";
  relayed.port = String((server.address() as { port: number }).port);
  return {
    url: relayed.toString(),
    /** Stops forwarding on every connection open now; new connections still get through. */
    silence() {
      for (const [downstream, upstream] of pairs.splice(0)) {
        downstream.unpipe(upstream);
        upstream.unpipe(downstream);
        downstream.pause();
        upstream.pause();
      }
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe.skipIf(!dbAvailable)("MatchStream LISTEN connection", () => {
  const databaseUrl = process.env.DATABASE_URL!;
  const cleanups: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  const notifyMatch = async (userId: string, matchId: string) => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query("SELECT pg_notify($1, $2)", [MATCH_CHANNEL, JSON.stringify({ userId, matchId })]);
    await client.end();
  };

  it("reconnects after the database drops the session, and delivers again", async () => {
    // What a Postgres restart does to the session: the server ends it from its side.
    const s = new MatchStream(databaseUrl);
    cleanups.push(() => s.stop());
    s.start();
    await until(() => s.connected);

    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    cleanups.push(() => admin.end());
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1", [
      LISTEN_APPLICATION_NAME,
    ]);
    await until(() => !s.connected);
    await until(() => s.connected);

    const alice = sink();
    s.subscribe("alice", alice.sink);
    await notifyMatch("alice", "after-restart");
    await until(() => alice.written.length > 0);
    expect(alice.written[0]).toContain("after-restart");
  });

  it("notices a connection that went silent without closing, and replaces it", async () => {
    // Nothing errors on a half-open socket that only ever listens - before the liveness check,
    // this stream reported connected forever and never received another notification.
    const relay = await silentableRelay(databaseUrl);
    cleanups.push(() => relay.close());
    const s = new MatchStream(relay.url, undefined, 300);
    cleanups.push(() => s.stop());
    s.start();
    await until(() => s.connected);

    relay.silence();
    await s.checkConnection();
    expect(s.connected).toBe(false);
    await until(() => s.connected);

    const alice = sink();
    s.subscribe("alice", alice.sink);
    await notifyMatch("alice", "after-silence");
    await until(() => alice.written.length > 0);
  });
});

describe.skipIf(!dbAvailable)("server close with a stream open", () => {
  const TAG = `match-stream-close-test-${Date.now()}`;
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await prisma.whitelist.deleteMany({ where: { walletAddress: `${TAG}-wallet` } });
    await prisma.user.deleteMany({ where: { walletAddress: `${TAG}-wallet` } });
  });

  it("finishes closing instead of waiting forever on the hijacked response", async () => {
    const env = loadEnv();
    const user = await prisma.user.create({ data: { walletAddress: `${TAG}-wallet` } });
    await prisma.whitelist.create({ data: { walletAddress: `${TAG}-wallet`, addedBy: TAG } });
    const cookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
      userId: user.id,
      walletAddress: user.walletAddress,
    });
    app = await buildServer(env);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as { port: number };

    const streamEnded = new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        {
          port,
          host: "127.0.0.1",
          path: "/matches/stream",
          headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve(body));
        },
      );
      req.on("error", reject);
      req.end();
    });
    await until(() => app!.matchStream.subscriberCount === 1);

    const closed = app.close().then(() => "closed");
    const timedOut = new Promise((resolve) => setTimeout(() => resolve("hung"), 5_000));
    expect(await Promise.race([closed, timedOut])).toBe("closed");
    expect(await streamEnded).toContain("event: ready");
  });
});
