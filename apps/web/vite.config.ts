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
  },
});
