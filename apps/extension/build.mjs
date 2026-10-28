// Builds the extension into dist/: the service worker, the side panel, the content script and the
// map page, with no runtime dependencies, plus the static files. The panel and the map page carry
// the site's own bubble map (apps/web/src/embed/tokenMapEmbed.tsx, with React) and its stylesheet. Minified but not obfuscated, with source maps beside them,
// as the Chrome Web Store's review asks.
//
//   node build.mjs           dist/ to load unpacked. The manifest gets the dev public key
//                            (dev-key.pub), so the unpacked extension always has the same ID and
//                            TrenchScanner's Settings can hand it a key (apps/web/src/extensionBridge.ts).
//   node build.mjs --store   the store build (user ask 2026-10-25): nothing that runs in a website's
//                            page. No content script (rings, pills, on-page alerts, safety screen,
//                            coin-page tools), no map frame for those pages, and none of their
//                            settings (`__STORE__` in the code). Without the key too (the store
//                            refuses one and assigns its own ID), zipped to
//                            release/trench-overlay-<version>.zip for upload.
//
// The manifest version must match package.json's, and every change to the extension bumps both
// (scripts/check-extension-version.sh, run in CI).
import { build } from "esbuild";
import postcss from "postcss";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { storePolicyGaps } from "./storePolicy.mjs";

const store = process.argv.includes("--store");
/** The store build's summary (STORE.md), without the rings the dev manifest names. */
const STORE_DESCRIPTION =
  "Your TrenchScanner alerts, with their flags, in a panel beside Axiom, Terminal and GMGN.";
const root = new URL("./", import.meta.url).pathname;
const out = join(root, "dist/");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const common = {
  bundle: true,
  define: { __STORE__: String(store) },
  minify: true,
  sourcemap: "linked",
  target: "chrome116",
  legalComments: "none",
  logLevel: "warning",
};
const web = join(root, "../web/src/");
// The site's code as the site's own build reads it (apps/web/vite.config.ts, tsconfig.json).
const site = {
  jsx: "automatic",
  conditions: ["trenchscanner-web"],
  alias: { "@site/tokenMapEmbed": join(web, "embed/tokenMapEmbed.tsx") },
  define: {
    __STORE__: String(store),
    "import.meta.env.VITE_API_URL": JSON.stringify("https://api.trenchscanner.app"),
    "import.meta.env.VITE_EXTENSION_IDS": JSON.stringify(""),
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
};
await Promise.all([
  build({ ...common, entryPoints: ["src/sw.ts"], outfile: `${out}sw.js`, format: "esm" }),
  build({
    ...common,
    ...site,
    entryPoints: ["src/panel/panel.ts"],
    outfile: `${out}panel.js`,
    format: "iife",
  }),
  // The bubble map tab's frame on a coin's page (content/mapTab.ts), and the content script that
  // rings alerted tokens on Axiom, Terminal and GMGN: neither in the store build.
  ...(store
    ? []
    : [
        build({
          ...common,
          ...site,
          entryPoints: ["src/map/page.ts"],
          outfile: `${out}map.js`,
          format: "iife",
        }),
        build({
          ...common,
          entryPoints: ["src/content/main.ts"],
          outfile: `${out}content.js`,
          format: "iife",
        }),
      ]),
  // The site's stylesheet and fonts, as the site bundles them.
  build({
    ...common,
    sourcemap: false,
    entryPoints: { map: join(web, "styles.css"), "map-fonts": join(web, "fonts.css") },
    outdir: out,
    loader: { ".woff2": "file", ".woff": "file" },
    assetNames: "fonts/[name]-[hash]",
  }),
]);
// The same stylesheet for a shadow root (map/siteMap.ts): the site's page-level selectors (:root,
// html, body) name the shadow host instead, and its fonts are left to map-fonts.css on the page.
await writeFile(join(out, "map-shadow.css"), shadowCss(await readFile(join(out, "map.css"), "utf8")));
await cp(join(root, "static"), out, { recursive: true });
// map.html and its stylesheet serve only the in-page frame; map-shadow.css serves the panel.
if (store) await Promise.all(["map.html", "map.css"].map((f) => rm(join(out, f))));

const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (manifest.version !== pkg.version) {
  throw new Error(`manifest version ${manifest.version} differs from package.json ${pkg.version}`);
}
if (manifest.description.length > 132) throw new Error("the store allows a 132-character description");
if (store) {
  const gaps = storePolicyGaps(
    manifest,
    await readFile(join(root, "STORE.md"), "utf8"),
    await readFile(join(root, "..", "web", "public", "extension-privacy.html"), "utf8"),
  );
  if (gaps.length) throw new Error(`the store listing doesn't cover this build: ${gaps.join("; ")}`);
  // Nothing runs on a website: no content script and no page a website can frame.
  delete manifest.content_scripts;
  delete manifest.web_accessible_resources;
  manifest.description = STORE_DESCRIPTION;
} else manifest.key = (await readFile(join(root, "dev-key.pub"), "utf8")).trim();
await writeFile(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

if (store) {
  const zipPath = join(root, "release", `trench-overlay-${manifest.version}.zip`);
  await mkdir(join(root, "release"), { recursive: true });
  await writeFile(zipPath, await zipDir(out));
  console.log(`store package: ${zipPath}`);
} else {
  console.log(`extension built to ${out} (load it unpacked)`);
}

/** `css` with :root, html and body read as the shadow host, and @font-face rules left out. */
function shadowCss(css) {
  const result = postcss.parse(css);
  result.walkAtRules("font-face", (rule) => rule.remove());
  result.walkRules((rule) => {
    rule.selectors = rule.selectors.map((sel) =>
      sel.replace(/^(?::root|html|body)((?:\[[^\]]*\]|:not\([^)]*\)|\.[\w-]+)*)(?:\s+body\b)?/, (_, quals) =>
        quals ? `:host(${quals})` : ":host",
      ),
    );
  });
  return result.toString();
}

/** The files under `dir`, deflated into a zip archive (no dependency, and the same on Windows). */
async function zipDir(dir) {
  const files = [];
  const walk = async (d) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.push(path);
    }
  };
  await walk(dir);
  files.sort();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const path of files) {
    const name = Buffer.from(relative(dir, path).split("\\").join("/"));
    const data = await readFile(path);
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    // DOS date 1980-01-01 00:00, so the same build makes the same zip.
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
