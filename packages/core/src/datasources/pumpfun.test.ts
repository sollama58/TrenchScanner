import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { PumpFunClient } from "./pumpfun.js";

let server: Server | undefined;

/** A local stand-in for Pump.fun's frontend API: `pages[offset / limit]`, or a 500 for "fail". */
async function serve(pages: (unknown[] | "fail")[]): Promise<{ url: string; paths: string[] }> {
  const paths: string[] = [];
  server = createServer((req, res) => {
    paths.push(req.url ?? "");
    const q = new URL(req.url ?? "", "http://x").searchParams;
    const page = pages[Number(q.get("offset")) / Number(q.get("limit"))] ?? [];
    res.setHeader("content-type", "application/json");
    if (page === "fail") {
      res.statusCode = 500;
      res.end("{}");
      return;
    }
    res.end(JSON.stringify(page));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("failed to bind test server");
  return { url: `http://127.0.0.1:${address.port}`, paths };
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("PumpFunClient.currentlyLive", () => {
  it("maps each live coin to its viewer count, reading one page when it isn't full", async () => {
    const { url, paths } = await serve([
      [
        { mint: "a", is_currently_live: true, num_participants: 67 },
        { mint: "b", is_currently_live: true },
        { mint: "c", is_currently_live: false, num_participants: 3 },
      ],
    ]);
    const live = await new PumpFunClient({ baseUrl: url }).currentlyLive({ limit: 5 });
    expect(live).toEqual(
      new Map([
        ["a", { viewers: 67 }],
        ["b", { viewers: null }],
      ]),
    );
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("/coins/currently-live?");
  });

  it("reads the next page while pages come back full", async () => {
    const { url, paths } = await serve([
      [
        { mint: "a", num_participants: 1 },
        { mint: "b", num_participants: 2 },
      ],
      [{ mint: "c", num_participants: 3 }],
    ]);
    const live = await new PumpFunClient({ baseUrl: url }).currentlyLive({ limit: 2 });
    expect([...live!.keys()]).toEqual(["a", "b", "c"]);
    expect(paths).toHaveLength(2);
  });

  it("answers null (unknown), not an empty set, when the feed fails", async () => {
    const { url } = await serve(["fail"]);
    expect(await new PumpFunClient({ baseUrl: url }).currentlyLive()).toBeNull();
  });
});
