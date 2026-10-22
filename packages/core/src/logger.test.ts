import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

const warn = console.warn;
const error = console.error;
const log = console.log;

afterEach(() => {
  console.warn = warn;
  console.error = error;
  console.log = log;
});

describe("logger secret redaction", () => {
  it("redacts a model alert key embedded in a logged string", () => {
    const secret = `tsma_${"a".repeat(43)}`;
    const lines: string[] = [];
    console.warn = (line?: unknown) => {
      lines.push(String(line));
    };
    createLogger("test").warn("websocket", {
      url: `wss://api.example/v1/model-alerts?key=${secret}`,
    });
    const text = lines.join("\n");
    expect(text).not.toContain(secret);
    expect(text).not.toContain("a".repeat(43));
  });
});
