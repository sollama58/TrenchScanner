import { describe, expect, it } from "vitest";
import { sageFromUrl } from "./sage";
import { categoryText, count, span } from "./components/SageView";

describe("TokenSage view link", () => {
  it("reads the mint from the address bar, and only a mint", () => {
    const mint = "ERV8GnQeAgh3K4udtHBpJfwe7pJJ6RfCcCRVAuGXABvU";
    expect(sageFromUrl(`?sage=${mint}`)).toBe(mint);
    expect(sageFromUrl("?sage=<script>")).toBeNull();
    expect(sageFromUrl("")).toBeNull();
  });

  it("formats its labels", () => {
    expect(categoryText("animal/squirrel")).toBe("Animal · squirrel");
    expect(categoryText("news_event")).toBe("News event");
    expect(span(45)).toBe("45s");
    expect(span(720)).toBe("12m");
    expect(span(3 * 86_400)).toBe("3d");
    expect(span(15 * 31_536_000)).toBe("15y");
    expect(count(241_704_623)).toBe("241.7M");
    expect(count(1234)).toBe("1.2k");
  });
});
