import { describe, expect, it } from "vitest";
import { MatchStream, type StreamSink } from "./matchStream.js";

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
    expect(s.subscribeCurated(sink().sink)).not.toBe(null);
    expect(s.subscribeCurated(sink().sink)).toBe(null);
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
    s.subscribeCurated(curatedA.sink);
    s.subscribeCurated(curatedB.sink);
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
    s.subscribeCurated(curated.sink);

    s.dispatch(notification("alice", "match-1"));

    expect(curated.written).toEqual([]);
  });

  it("ignores unparseable and id-less curated payloads", () => {
    const s = stream();
    const curated = sink();
    s.subscribeCurated(curated.sink);

    s.dispatchCurated("{not json");
    s.dispatchCurated(JSON.stringify({}));

    expect(curated.written).toEqual([]);
  });

  it("disposes a curated subscriber cleanly", () => {
    const s = stream();
    const curated = sink();
    const dispose = s.subscribeCurated(curated.sink)!;
    dispose();

    s.dispatchCurated(JSON.stringify({ alertId: "alert-1" }));

    expect(curated.written).toEqual([]);
  });
});
