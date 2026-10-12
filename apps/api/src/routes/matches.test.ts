import { describe, expect, it } from "vitest";
import { currentMarketCap, matchAlertSnapshot, keyFollowsModel, listQuerySchema } from "./matches.js";

const T = (isoMinutesAgo: number) => new Date(Date.now() - isoMinutesAgo * 60_000);

describe("currentMarketCap", () => {
  it("prefers the live ping when it's newer than the snapshot", () => {
    const result = currentMarketCap(
      { liveMarketCapUsd: 250_000, liveDataAt: T(1) },
      { marketCapUsd: 200_000, takenAt: T(6) },
    );
    expect(result.marketCapUsd).toBe(250_000);
  });

  it("prefers the snapshot when IT is the newer of the two", () => {
    // Happens for a token nobody has viewed recently: live pings stopped, but it's still in the
    // mcap band so the scan cycle keeps writing snapshots.
    const result = currentMarketCap(
      { liveMarketCapUsd: 250_000, liveDataAt: T(30) },
      { marketCapUsd: 200_000, takenAt: T(2) },
    );
    expect(result.marketCapUsd).toBe(200_000);
  });

  it("falls back to the snapshot when there's no live ping at all", () => {
    const result = currentMarketCap(
      { liveMarketCapUsd: null, liveDataAt: null },
      { marketCapUsd: 200_000, takenAt: T(3) },
    );
    expect(result.marketCapUsd).toBe(200_000);
  });

  it("uses the live ping when there's no snapshot at all", () => {
    const result = currentMarketCap({ liveMarketCapUsd: 250_000, liveDataAt: T(1) }, null);
    expect(result.marketCapUsd).toBe(250_000);
  });

  it("returns nulls when neither reading exists", () => {
    expect(currentMarketCap({ liveMarketCapUsd: null, liveDataAt: null }, null)).toEqual({
      marketCapUsd: null,
      at: null,
    });
  });

  it("ignores a live timestamp with no value attached", () => {
    // Defensive: liveDataAt set but liveMarketCapUsd null shouldn't win and yield a null figure.
    const result = currentMarketCap(
      { liveMarketCapUsd: null, liveDataAt: T(1) },
      { marketCapUsd: 200_000, takenAt: T(9) },
    );
    expect(result.marketCapUsd).toBe(200_000);
  });

  it("reports the timestamp belonging to whichever reading it chose", () => {
    const liveAt = T(1);
    const result = currentMarketCap(
      { liveMarketCapUsd: 250_000, liveDataAt: liveAt },
      { marketCapUsd: 200_000, takenAt: T(6) },
    );
    expect(result.at).toBe(liveAt);
  });
});

describe("listQuerySchema - includeCurated", () => {
  const parse = (query: Record<string, string>) => listQuerySchema.parse(query);

  it("leaves curated alerts out unless they are asked for", () => {
    expect(parse({}).includeCurated).toBe("off");
    expect(parse({ page: "2" }).includeCurated).toBe("off");
  });

  it("accepts the affirmative forms a client actually sends", () => {
    expect(parse({ includeCurated: "true" }).includeCurated).toBe("on");
    expect(parse({ includeCurated: "1" }).includeCurated).toBe("on");
  });

  it('reads "saved" as following the reader\'s own switch', () => {
    expect(parse({ includeCurated: "saved" }).includeCurated).toBe("saved");
  });

  it('reads "false" as false - the trap z.coerce.boolean() falls into', () => {
    // Every query value arrives as a string, and coercion treats any non-empty one as true, so
    // the flag would have been impossible to turn off once a client started sending it.
    expect(parse({ includeCurated: "false" }).includeCurated).toBe("off");
    expect(parse({ includeCurated: "0" }).includeCurated).toBe("off");
    expect(parse({ includeCurated: "" }).includeCurated).toBe("off");
  });
});

describe("keyFollowsModel", () => {
  it("matches a model anywhere in the key's trailing model set, and only a whole id", () => {
    // What a curated alert clears: only the readers whose answers can hold that model's calls.
    expect(keyFollowsModel("user1:24:on:rules,trees", "trees")).toBe(true);
    expect(keyFollowsModel("feed:36:rules", "rules")).toBe(true);
    expect(keyFollowsModel("user1:24:on:narrative-blend", "narrative")).toBe(false);
    expect(keyFollowsModel("user1:24:on:rules,trees", "consensus")).toBe(false);
    // Model alerts off: no calls in the answer, so no model's alert affects it.
    expect(keyFollowsModel("user1:24:off:", "rules")).toBe(false);
  });
});

describe("matchAlertSnapshot", () => {
  const snapshot = { id: "s", priceUsd: 0.00004, marketCapUsd: 40_000 };

  it("shows the price a fresh-quote alert was priced at, on the snapshot's supply", () => {
    const shown = matchAlertSnapshot(snapshot, 60_000);
    expect(shown).toMatchObject({ id: "s", marketCapUsd: 60_000 });
    expect(shown.priceUsd).toBeCloseTo(0.00006, 12);
  });

  it("keeps the snapshot's own figures on an alert priced from it", () => {
    expect(matchAlertSnapshot(snapshot, null)).toBe(snapshot);
    expect(matchAlertSnapshot({ ...snapshot, marketCapUsd: 0 }, 60_000).marketCapUsd).toBe(0);
  });
});
