// Builds the unpacked extension into dist/: two bundles (service worker, side panel) with no runtime dependencies, plus the static files. Minified but not obfuscated, with
// source maps beside them, as the Chrome Web Store's review asks. Load dist/ unpacked to try it.
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const out = new URL("./dist/", import.meta.url).pathname;
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const common = {
  bundle: true,
  minify: true,
  sourcemap: "linked",
  target: "chrome116",
  legalComments: "none",
  logLevel: "warning",
};
await Promise.all([
  build({ ...common, entryPoints: ["src/sw.ts"], outfile: `${out}sw.js`, format: "esm" }),
  build({ ...common, entryPoints: ["src/panel/panel.ts"], outfile: `${out}panel.js`, format: "iife" }),
]);
await cp("static", out, { recursive: true });
console.log(`extension built to ${out}`);
