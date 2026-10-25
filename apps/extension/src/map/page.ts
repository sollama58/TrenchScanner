import { isMintAddress } from "../shared/mint";
import { siteRequest } from "./siteMap";
import { mountTokenMap } from "@site/tokenMapEmbed";

/**
 * The extension's map page (map.html): the site's own bubble map for one coin, framed in the
 * bubble map tab on a coin's page (content/mapTab.ts). A page of the extension's own, so the
 * site's map code and its reads never run in the trading site's page. Its reads go through the
 * service worker as the panel's do, and only while the reader keeps the map tab on (sw.ts).
 */
const mint = new URLSearchParams(location.search).get("mint") ?? "";
const root = document.getElementById("map")!;
if (isMintAddress(mint)) mountTokenMap(root, mint, siteRequest);
else root.textContent = "Not a coin address.";
