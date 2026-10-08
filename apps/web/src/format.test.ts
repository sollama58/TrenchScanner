import { describe, expect, it } from "vitest";
import {
  ago,
  until,
  change,
  halfHour,
  multiple,
  pct,
  shortAddress,
  signedPct,
  stakes,
  tokenLabel,
  tokenThumb,
  usd,
} from "./format";

describe("format", () => {
  it("abbreviates dollar figures", () => {
    expect(usd(950)).toBe("$950");
    expect(usd(12_345)).toBe("$12.3K");
    expect(usd(1_250_000)).toBe("$1.25M");
    expect(usd(null)).toBe("–");
  });

  it("turns a return into a price multiple", () => {
    expect(multiple(100)).toBe("2.0x");
    expect(multiple(300)).toBe("4.0x");
    expect(multiple(1900)).toBe("20x");
    expect(multiple(null)).toBe("–");
  });

  it("signs returns and counts stakes", () => {
    expect(signedPct(12.4)).toBe("+12%");
    expect(signedPct(-8)).toBe("-8%");
    expect(signedPct(0.2)).toBe("0%");
    expect(signedPct(null)).toBe("–");
    expect(stakes(340)).toBe("+3.4 stakes");
    expect(stakes(-100)).toBe("-1.0 stake");
    expect(stakes(2)).toBe("0 stakes");
    expect(stakes(undefined)).toBe("–");
  });

  it("measures change and handles a missing base", () => {
    expect(change(100, 150)).toBe(50);
    expect(change(0, 150)).toBeNull();
    expect(change(100, null)).toBeNull();
  });

  it("formats rates, ages and labels", () => {
    expect(pct(75.4)).toBe("75%");
    expect(pct(null)).toBe("–");
    const now = Date.parse("2026-10-03T12:00:00Z");
    expect(ago("2026-10-03T11:55:00Z", now)).toBe("5m ago");
    expect(ago("2026-10-03T09:00:00Z", now)).toBe("3h ago");
    expect(shortAddress("So11111111111111111111111111111111111111112")).toBe("So11…1112");
    expect(tokenLabel({ symbol: "WIF", name: "dogwifhat", mintAddress: "x" })).toBe("$WIF");
  });
});

describe("tokenThumb", () => {
  const cid = "bafkreihxafgbuv2tw7icchpr27buj42hltprkndct4544qkrtsylsxqovy";
  const thumb = `https://pump.mypinata.cloud/ipfs/${cid}?img-width=96&img-height=96&img-fit=cover`;

  it("resizes IPFS gateway images through Pinata", () => {
    expect(tokenThumb(`https://ipfs.io/ipfs/${cid}`)).toBe(thumb);
    expect(tokenThumb(`https://cf-ipfs.com/ipfs/${cid}`)).toBe(thumb);
    expect(tokenThumb(`https://gateway.pinata.cloud/ipfs/${cid}?filename=a.png`)).toBe(thumb);
    expect(tokenThumb(`https://${cid}.ipfs.dweb.link/`)).toBe(thumb);
  });

  it("leaves other hosts and IPFS sub-paths alone", () => {
    const tw = "https://pbs.twimg.com/media/abc.jpg";
    expect(tokenThumb(tw)).toBe(tw);
    const sub = `https://ipfs.io/ipfs/${cid}/image.png`;
    expect(tokenThumb(sub)).toBe(sub);
  });
});

describe("until", () => {
  const now = Date.UTC(2026, 9, 5, 12, 0, 0);
  it("says how far off a future moment is", () => {
    expect(until(new Date(now + 5 * 60_000), now)).toBe("in 5m");
    expect(until(new Date(now + 3 * 3600_000), now)).toBe("in 3h");
    expect(until(new Date(now + 3 * 86_400_000), now)).toBe("in 3d");
    expect(until(new Date(now - 1000), now)).toBe("now");
    expect(until(null, now)).toBe("never");
  });
});

describe("halfHour", () => {
  // The local minutes of a UTC hour: 30 in Kolkata, 45 in Kathmandu, 0 on whole-hour zones.
  const at = (minutes: number) => ({ getMinutes: () => minutes }) as Date;
  it("shows a bucket's minutes only in a :30 or :45 zone", () => {
    expect(halfHour(at(30))).toBe("2-digit");
    expect(halfHour(at(45))).toBe("2-digit");
    expect(halfHour(at(0))).toBeUndefined();
  });
});
