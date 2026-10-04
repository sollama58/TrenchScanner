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

export default defineConfig({
  plugins: [react(), fontPreload()],
  server: { port: 5173 },
});
