import { describe, expect, it } from "vitest";
import { clientErrorBody } from "./clientErrors";

describe("clientErrorBody", () => {
  it("cuts each field to the API's limits", () => {
    const e = new Error("x".repeat(900));
    e.stack = "s".repeat(5_000);
    const body = clientErrorBody("w".repeat(200), e, "/p".repeat(300), "v".repeat(100));
    expect(body.where).toHaveLength(80);
    expect(body.message).toHaveLength(500);
    expect(body.stack).toHaveLength(2_000);
    expect(body.version).toHaveLength(40);
    expect(body.path).toHaveLength(200);
  });

  it("reads a thrown non-Error", () => {
    expect(clientErrorBody("The chart", "boom", "/", "1")).toMatchObject({
      message: "boom",
      where: "The chart",
    });
  });
});
