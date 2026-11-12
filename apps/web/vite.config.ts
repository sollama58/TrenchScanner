import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Preloads the Latin font files from index.html, so the browser fetches them alongside the CSS
 * instead of only after it has parsed the CSS and laid out text (src/fonts.css).
 */
function fontPreload(): Plugin {
  return {
    name: "font-preload",
    apply: "build",
    transformIndexHtml(_html, ctx) {
      const files = Object.keys(ctx.bundle ?? {}).filter((f) => /-latin-wght-normal-[\w-]+\.woff2$/.test(f));
      return files.map((f) => ({
        tag: "link",
        attrs: { rel: "preload", as: "font", type: "font/woff2", href: `/${f}`, crossorigin: "" },
        injectTo: "head" as const,
      }));
    },
  };
}

/**
 * The code each first screen loads lazily (src/routes.ts), named for index.html's boot script:
 * the tab a link opens (#model, ...) and "signin" for the sign-in page. That script starts these
 * downloads at once, as it does the screen's API calls. Left to main.tsx, each waited on the main
 * bundle to download and run before it was even asked for: one more round trip before the screen
 * could paint. Each list is the chunk and the chunks it imports, less what index.html already
 * preloads. Written into a <meta>, so the boot script's text (and its CSP hash) stays the same
 * from one build to the next.
 */
const BOOT_CHUNKS: Record<string, string> = {
  signin: "src/components/SignIn.tsx",
  model: "src/tabs/ModelTab.tsx",
  lighthouse: "src/tabs/LighthouseTab.tsx",
  filters: "src/tabs/FiltersTab.tsx",
  settings: "src/tabs/SettingsTab.tsx",
  admin: "src/tabs/AdminTab.tsx",
};

function bootChunks(): Plugin {
  return {
    name: "boot-chunks",
    apply: "build",
    transformIndexHtml(_html, ctx) {
      const bundle = ctx.bundle;
      // The dashboard only: Asyl and the TokenSage page have no such screens.
      if (!bundle || !ctx.chunk || resolve(ctx.filename) !== resolve(import.meta.dirname, "index.html"))
        return;
      const chunkOf = (file: string) => {
        const out = bundle[file];
        return out?.type === "chunk" ? out : null;
      };
      const graph = (file: string, into = new Set<string>()) => {
        if (into.has(file)) return into;
        into.add(file);
        for (const dep of chunkOf(file)?.imports ?? []) graph(dep, into);
        return into;
      };
      const preloaded = graph(ctx.chunk.fileName);
      const lists: string[] = [];
      for (const [key, source] of Object.entries(BOOT_CHUNKS)) {
        // The chunk holding the module. Rollup leaves facadeModuleId null on some (AdminTab's).
        const id = resolve(import.meta.dirname, source);
        const entry = Object.values(bundle).find(
          (c) =>
            c.type === "chunk" && c.isDynamicEntry && (c.facadeModuleId === id || c.moduleIds.includes(id)),
        );
        if (!entry) throw new Error(`boot-chunks: no lazy chunk for ${source}`);
        const files = [...graph(entry.fileName)].filter((f) => !preloaded.has(f)).map((f) => `/${f}`);
        lists.push(`${key}=${files.join(" ")}`);
      }
      return [
        {
          tag: "meta",
          // "name=/a.js /b.js;name=...": no quotes, which an attribute would have to escape.
          attrs: { name: "ts-boot-chunks", content: lists.join(";") },
          injectTo: "head-prepend" as const,
        },
      ];
    },
  };
}

/**
 * The build's version: the deployed commit on Render (RENDER_GIT_COMMIT), else the local checkout's
 * HEAD, else the build time. BUILD_VERSION overrides all three. Keyed on the commit rather than the
 * build time so a redeploy of the same commit doesn't ask every open tab to reload for nothing.
 */
function buildVersion(): string {
  const set = process.env.BUILD_VERSION ?? process.env.RENDER_GIT_COMMIT;
  if (set) return set.slice(0, 40);
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim()
      .slice(0, 40);
  } catch {
    return `t${Date.now()}`;
  }
}

const APP_VERSION = buildVersion();

/**
 * Writes /version.json next to the build. Open tabs read it (src/version.ts) to learn that a newer
 * dashboard has been deployed; the same value is baked into the bundle as __APP_VERSION__.
 */
function versionFile(): Plugin {
  return {
    name: "version-file",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: `${JSON.stringify({ version: APP_VERSION, builtAt: new Date().toISOString() })}\n`,
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [react(), fontPreload(), bootChunks(), versionFile()],
  // Same condition as apps/web/tsconfig.json: chartMarks is bundled from source. The package's
  // Node conditions still point at packages/core/dist, which this build does not produce.
  resolve: { conditions: ["trenchscanner-web"] },
  // Empty under `vite` (dev) and vitest: nothing is deployed there, so there is nothing to check for.
  define: { __APP_VERSION__: JSON.stringify(command === "build" ? APP_VERSION : "") },
  server: { port: 5173 },
  build: {
    rollupOptions: {
      // The dashboard, the /tokensage page (unlisted for now), and Asyl (asyl.trenchscanner.app,
      // its own static site in render.yaml), which share its styles but not its code.
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        tokensage: resolve(import.meta.dirname, "tokensage/index.html"),
        asyl: resolve(import.meta.dirname, "asyl/index.html"),
      },
    },
  },
}));
