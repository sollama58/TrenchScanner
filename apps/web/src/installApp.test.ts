import { describe, expect, it } from "vitest";
import { mobilePlatform, runningInstalled } from "./installApp";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD_AS_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

describe("mobilePlatform", () => {
  it("knows iPhones, iPads posing as a Mac, and Android", () => {
    expect(mobilePlatform(IPHONE)).toBe("ios");
    expect(mobilePlatform(IPAD_AS_MAC, 5)).toBe("ios");
    expect(mobilePlatform(ANDROID)).toBe("android");
  });

  it("is null on a desktop, including a real Mac", () => {
    expect(mobilePlatform(WINDOWS)).toBeNull();
    expect(mobilePlatform(IPAD_AS_MAC, 0)).toBeNull();
  });
});

describe("runningInstalled", () => {
  const win = (standaloneMedia: boolean, navStandalone?: boolean) =>
    ({
      navigator: { standalone: navStandalone },
      matchMedia: (q: string) => ({ matches: standaloneMedia && q.includes("standalone") }),
    }) as unknown as Window;

  it("is true opened from the home screen, on Android or iOS", () => {
    expect(runningInstalled(win(true))).toBe(true);
    expect(runningInstalled(win(false, true))).toBe(true);
  });

  it("is false in a browser tab", () => {
    expect(runningInstalled(win(false))).toBe(false);
  });
});
