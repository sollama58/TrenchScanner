/**
 * Asyl's addresses. On asyl.trenchscanner.app every path serves the one page (render.yaml), so the
 * path says what to open: /w/<wallet>, /t/<coin>, /m/<saved map>, /s/<shared map>. Under `vite`
 * (and the dashboard's own host) the page sits at /asyl/, so that prefix is dropped first.
 */

export type AsylRoute =
  | { kind: "home" }
  | { kind: "wallet"; address: string }
  | { kind: "token"; address: string }
  | { kind: "map"; id: string }
  | { kind: "shared"; slug: string };

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ID = /^[A-Za-z0-9_-]{6,40}$/;

export function basePath(pathname: string): string {
  return pathname === "/asyl" || pathname.startsWith("/asyl/") ? "/asyl" : "";
}

export function parseRoute(pathname: string): AsylRoute {
  const rest = pathname.slice(basePath(pathname).length).replace(/\/+$/, "");
  const [, head, value] = rest.split("/");
  if (!value) return { kind: "home" };
  if (head === "w" && ADDRESS.test(value)) return { kind: "wallet", address: value };
  if (head === "t" && ADDRESS.test(value)) return { kind: "token", address: value };
  if (head === "m" && ID.test(value)) return { kind: "map", id: value };
  if (head === "s" && ID.test(value)) return { kind: "shared", slug: value };
  return { kind: "home" };
}

export function routePath(r: AsylRoute, base = ""): string {
  switch (r.kind) {
    case "home":
      return `${base}/`;
    case "wallet":
      return `${base}/w/${r.address}`;
    case "token":
      return `${base}/t/${r.address}`;
    case "map":
      return `${base}/m/${r.id}`;
    case "shared":
      return `${base}/s/${r.slug}`;
  }
}

/** A shared map's public link. */
export function sharedLink(
  slug: string,
  origin = typeof location === "undefined" ? "" : location.origin,
): string {
  const base = typeof location === "undefined" ? "" : basePath(location.pathname);
  return `${origin}${routePath({ kind: "shared", slug }, base)}`;
}
