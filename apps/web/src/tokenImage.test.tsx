import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TokenImage } from "./components/TokenImage";

const PUMP = "2bjLxGw7HYx47ir6RJq8ijXjMJnVFtFCgBFzTN9Gpump";
const CID = "QmXE32GkWar4APXXy2wM4fWbMPBkWJb4ebSM6GH6xKQf2h";
const initials = <span className="placeholder">AB</span>;

const html = (url: string | null, mint?: string) =>
  renderToStaticMarkup(
    <TokenImage
      url={url}
      mint={mint}
      size={96}
      width={44}
      height={44}
      className="avatar"
      fallback={initials}
    />,
  );

describe("TokenImage", () => {
  it("starts on the thumbnail and pulses until it loads", () => {
    const out = html(`https://ipfs.io/ipfs/${CID}`, PUMP);
    expect(out).toContain(`src="https://pump.mypinata.cloud/ipfs/${CID}?img-width=96`);
    expect(out).toContain('class="avatar"');
    expect(out).toContain('data-loading=""');
    expect(out).not.toContain("placeholder");
  });

  it("shows a Pump.fun coin's image from its CDN when there is no URL (user report 2026-10-23)", () => {
    expect(html(null, PUMP)).toContain(`src="https://images.pump.fun/coin-image/${PUMP}?variant=96x96"`);
  });

  it("shows the initials when there is nothing to load", () => {
    expect(html(null, "4sF5F6jxjj1MTPbc379n7rchnrxUdC38y3RMmcDXvNsi")).toBe(
      '<span class="placeholder">AB</span>',
    );
    expect(html("http://plain.example/x.png")).toBe('<span class="placeholder">AB</span>');
  });
});
