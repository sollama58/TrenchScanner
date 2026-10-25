// Builds the extension into dist/: two bundles (service worker, side panel) with no runtime
// dependencies, plus the static files. Minified but not obfuscated, with source maps beside them,
// as the Chrome Web Store's review asks.
//
//   node build.mjs           dist/ to load unpacked. The manifest gets the dev public key
//                            (dev-key.pub), so the unpacked extension always has the same ID and
//                            TrenchScanner's Settings can hand it a key (apps/web/src/extensionBridge.ts).
//   node build.mjs --store   dist/ without the key (the store refuses one and assigns its own ID),
//                            zipped to release/trench-overlay-<version>.zip for upload.
//
// The manifest version must match package.json's, and every change to the extension bumps both
// (scripts/check-extension-version.sh, run in CI).
import { build } from "esbuild";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

const store = process.argv.includes("--store");
const root = new URL("./", import.meta.url).pathname;
const out = join(root, "dist/");
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
  // The rings build: the content script that rings alerted tokens on Axiom, Terminal and GMGN.
  build({ ...common, entryPoints: ["src/content/main.ts"], outfile: `${out}content.js`, format: "iife" }),
]);
await cp(join(root, "static"), out, { recursive: true });

const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (manifest.version !== pkg.version) {
  throw new Error(`manifest version ${manifest.version} differs from package.json ${pkg.version}`);
}
if (manifest.description.length > 132) throw new Error("the store allows a 132-character description");
if (!store) manifest.key = (await readFile(join(root, "dev-key.pub"), "utf8")).trim();
await writeFile(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

if (store) {
  const zipPath = join(root, "release", `trench-overlay-${manifest.version}.zip`);
  await mkdir(join(root, "release"), { recursive: true });
  await writeFile(zipPath, await zipDir(out));
  console.log(`store package: ${zipPath}`);
} else {
  console.log(`extension built to ${out} (load it unpacked)`);
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
