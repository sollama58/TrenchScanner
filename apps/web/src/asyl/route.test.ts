import { describe, expect, it } from "vitest";
import { parseRoute, routePath } from "./route";

const W = "5fgUEyhQGy672GW9Z83Lhb2UhQU9nobHz6k4owYyaH7R";

describe("Asyl routes", () => {
  it("reads each kind of path, with or without the dev prefix", () => {
    expect(parseRoute("/")).toEqual({ kind: "home" });
    expect(parseRoute("/asyl/")).toEqual({ kind: "home" });
    expect(parseRoute(`/w/${W}`)).toEqual({ kind: "wallet", address: W });
    expect(parseRoute(`/asyl/t/${W}/`)).toEqual({ kind: "token", address: W });
    expect(parseRoute("/m/clx123abc")).toEqual({ kind: "map", id: "clx123abc" });
    expect(parseRoute("/s/Ab3_dE9-xyZ1")).toEqual({ kind: "shared", slug: "Ab3_dE9-xyZ1" });
  });

  it("sends anything else home", () => {
    expect(parseRoute("/w/not-an-address")).toEqual({ kind: "home" });
    expect(parseRoute("/x/whatever")).toEqual({ kind: "home" });
    expect(parseRoute("/asylum")).toEqual({ kind: "home" });
  });

  it("writes paths that read back the same", () => {
    for (const r of [
      { kind: "wallet", address: W },
      { kind: "token", address: W },
      { kind: "map", id: "clx123abc" },
      { kind: "shared", slug: "Ab3_dE9-xyZ1" },
    ] as const) {
      expect(parseRoute(routePath(r))).toEqual(r);
      expect(parseRoute(routePath(r, "/asyl"))).toEqual(r);
    }
  });
});
