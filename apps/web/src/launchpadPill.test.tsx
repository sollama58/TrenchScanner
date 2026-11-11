import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LaunchpadPill, launchpadOf } from "./launchpadPill";

describe("launchpadOf", () => {
  it("names the launchpads the scan takes, in any spelling a row holds", () => {
    expect(launchpadOf("pumpfun")).toEqual({ id: "pumpfun", label: "Pump.fun" });
    expect(launchpadOf("stonks")).toEqual({ id: "stonks", label: "Stonks" });
    expect(launchpadOf("float")).toEqual({ id: "float", label: "Float" });
    expect(launchpadOf("letsbonk.fun")).toEqual({ id: "bonk", label: "Bonk" });
    expect(launchpadOf("raydium-launchlab")).toEqual({ id: "launchlab", label: "LaunchLab" });
  });

  it("names nothing it can't vouch for", () => {
    expect(launchpadOf(null)).toBeNull();
    expect(launchpadOf(undefined)).toBeNull();
    expect(launchpadOf("met-dbc")).toBeNull();
    expect(launchpadOf("constructor")).toBeNull();
  });
});

describe("LaunchpadPill", () => {
  it("shows the launchpad's name, and nothing for an unknown one", () => {
    const html = renderToStaticMarkup(<LaunchpadPill token={{ launchpad: "float" }} />);
    expect(html).toContain("Float");
    expect(html).toContain("launchpad-float");
    expect(renderToStaticMarkup(<LaunchpadPill token={{ launchpad: null }} />)).toBe("");
  });
});
