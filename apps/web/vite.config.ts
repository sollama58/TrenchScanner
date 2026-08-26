import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  // The whole monorepo shares one root .env (see apps/api/apps/worker's bootstrap-env.ts for
  // why). Vite only ever exposes VITE_-prefixed keys to client code, so server secrets in that
  // same file (DATABASE_URL, JWT_SECRET, HELIUS_API_KEY, ...) are never bundled into the browser.
  envDir: resolve(here, "../.."),
  // @solana/web3.js and friends assume a Node-like global; Buffer itself is polyfilled
  // explicitly in src/polyfills.ts (imported first in main.tsx), this just covers the bare
  // `global` reference some of the same libraries make.
  define: {
    global: "globalThis",
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      output: {
        // Without this, Rollup's default is one ~600kB app+vendor bundle - every deploy
        // invalidates the whole thing, so a returning user re-downloads React, @solana/web3.js
        // and the wallet adapters (which almost never change) just because a component's JSX
        // changed. Splitting vendor code into its own hashed chunks means those chunks keep the
        // same filename (and stay cached) across deploys where only our own app code changed.
        manualChunks: (id) => vendorChunkFor(id),
      },
    },
  },
});

/**
 * Buckets a node_modules module into a coarse vendor chunk by top-level package name, for the
 * handful of large, semantically-distinct dependencies that dominate bundle size and tend to
 * change independently of both our own code and each other:
 *  - vendor-react: essentially never changes without a deliberate React version bump.
 *  - vendor-wallet: the wallet-adapter/wallet-standard surface we integrate against directly in
 *    AuthContext - worth isolating from web3.js itself since it churns a bit more.
 *  - vendor-solana: @solana/web3.js plus the two small crypto/polyfill libs we import directly
 *    alongside it (bs58, buffer) - the "talk to the chain" layer.
 * Everything else (smaller transitive deps not named above) is left for Rollup's own default
 * chunking - forcing every last transitive dependency into a named bucket produced circular
 * chunk dependencies here (a small shared polyfill imported by both a bucketed and an
 * un-bucketed module), which is worse for caching than just letting Rollup decide. Application
 * code (anything outside node_modules) is likewise left alone, so it stays in the entry chunk
 * that's expected to change on nearly every deploy.
 */
function vendorChunkFor(id: string): string | undefined {
  if (!id.includes("node_modules")) return undefined;

  const afterNodeModules = id.split("node_modules/").at(-1) ?? "";
  const segments = afterNodeModules.split("/");
  const pkgName = segments[0]?.startsWith("@") ? `${segments[0]}/${segments[1]}` : segments[0];

  if (pkgName === "react" || pkgName === "react-dom" || pkgName === "scheduler") return "vendor-react";
  if (pkgName?.startsWith("@solana/wallet-adapter") || pkgName?.startsWith("@solana/wallet-standard")) {
    return "vendor-wallet";
  }
  if (pkgName === "@solana/web3.js" || pkgName === "bs58" || pkgName === "buffer") return "vendor-solana";
  return undefined;
}
