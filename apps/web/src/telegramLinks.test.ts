import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TELEGRAM_ALERT_LINKS, TELEGRAM_MAX_MCAP_FLOOR } from "./api";

const core = (file: string) =>
  readFileSync(resolve(import.meta.dirname, "../../../packages/core/src/telegram", file), "utf8");

describe("the Telegram panel's chat settings", () => {
  it("offers the links and the /alerts floor the API takes (audit 10-27 WB-30)", () => {
    const links = /export const ALERT_LINKS = \[([^\]]*)\]/.exec(core("format.ts"))?.[1] ?? "";
    expect(TELEGRAM_ALERT_LINKS.map((l) => l.key)).toEqual([...links.matchAll(/"(\w+)"/g)].map((m) => m[1]));
    const floor = /export const MAX_MCAP_FLOOR = ([\d_]+);/.exec(core("settings.ts"))?.[1] ?? "";
    expect(TELEGRAM_MAX_MCAP_FLOOR).toBe(Number(floor.replaceAll("_", "")));
  });
});
