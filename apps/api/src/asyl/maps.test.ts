import { describe, expect, it } from "vitest";
import { MAP_BODY_LIMIT, MAP_NODES_MAX, mapDocSchema } from "./maps.js";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const addr = (i: number) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor(n / 58)) s = B58[n % 58] + s;
  return s.padStart(44, "W");
};

describe("mapDocSchema", () => {
  it("saves a coin with every historical holder: hundreds of wallets, well under the body limit", () => {
    const mint = addr(0);
    const wallets = Array.from({ length: 1_000 }, (_, i) => addr(i + 1));
    const doc = {
      v: 1,
      nodes: [
        {
          id: mint,
          kind: "token",
          name: "$PAST",
          tags: [],
          image: `https://example.com/${"x".repeat(200)}.png`,
        },
        ...wallets.map((id) => ({ id, kind: "wallet", name: null, tags: ["sniper"], risk: 40, win: 55 })),
      ],
      edges: wallets.flatMap((w, i) => [
        {
          a: w,
          b: mint,
          kind: "traded",
          weight: 1.5,
          label: "2 buys, 1 sell · +0.42 SOL",
          source: "stored",
          mint,
        },
        ...(i % 2
          ? [
              {
                a: wallets[i - 1]!,
                b: w,
                kind: "funded",
                weight: 1,
                label: "Funded · 1 SOL",
                source: "stored",
              },
            ]
          : []),
      ]),
      positions: Object.fromEntries([mint, ...wallets].map((id, i) => [id, [i * 37.25, i * -12.5]])),
      pinned: wallets.slice(0, 500),
    };
    expect(mapDocSchema.safeParse(doc).success).toBe(true);
    expect(JSON.stringify(doc).length).toBeLessThan(MAP_BODY_LIMIT / 2);
    expect(MAP_NODES_MAX).toBeGreaterThan(doc.nodes.length);
  });
});
