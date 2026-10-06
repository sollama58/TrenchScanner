import { describe, expect, it } from "vitest";
import { apiUrlFor } from "./api";

describe("apiUrlFor", () => {
  it("sends trenchscanner.app pages to the API on its own subdomain", () => {
    expect(apiUrlFor("trenchscanner.app", "https://trenchscanner-api.onrender.com")).toBe(
      "https://api.trenchscanner.app",
    );
    expect(apiUrlFor("www.trenchscanner.app", "https://x")).toBe("https://api.trenchscanner.app");
    expect(apiUrlFor("WWW.TrenchScanner.app", "https://x")).toBe("https://api.trenchscanner.app");
  });

  it("keeps the configured API everywhere else", () => {
    expect(apiUrlFor("trenchscanner-web.onrender.com", "https://trenchscanner-api.onrender.com/")).toBe(
      "https://trenchscanner-api.onrender.com",
    );
    // A look-alike host is not the same site.
    expect(apiUrlFor("nottrenchscanner.app", "https://a")).toBe("https://a");
    expect(apiUrlFor("localhost", undefined)).toBe("http://localhost:4000");
  });
});
