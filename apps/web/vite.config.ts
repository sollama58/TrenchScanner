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
  plugins: [react(), fontPreload(), versionFile()],
  // Same condition as apps/web/tsconfig.json: chartMarks is bundled from source. The package's
  // Node conditions still point at packages/core/dist, which this build does not produce.
  resolve: { conditions: ["trenchscanner-web"] },
  // Empty under `vite` (dev) and vitest: nothing is deployed there, so there is nothing to check for.
  define: { __APP_VERSION__: JSON.stringify(command === "build" ? APP_VERSION : "") },
  server: { port: 5173 },
  build: {
    rollupOptions: {
      // The dashboard, and the /tokensage page (unlisted for now), which shares its styles but
      // not its code.
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        tokensage: resolve(import.meta.dirname, "tokensage/index.html"),
      },
    },
  },
}));
