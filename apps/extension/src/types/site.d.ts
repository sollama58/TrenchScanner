/**
 * The site's own bubble map (apps/web/src/embed/tokenMapEmbed.tsx), bundled in by build.mjs's
 * alias. Typed here so the extension's typecheck doesn't walk the site's code; the site's own
 * typecheck covers that file.
 */
declare module "@site/tokenMapEmbed" {
  export interface SiteCall {
    method: string;
    path: string;
    body: string | null;
  }
  export interface SiteAnswer {
    status: number;
    body: string;
  }
  export function mountTokenMap(
    root: HTMLElement,
    mint: string,
    request: (call: SiteCall) => Promise<SiteAnswer>,
  ): () => void;
}
