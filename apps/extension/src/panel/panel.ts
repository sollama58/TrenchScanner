import { FLAG_IDS, FLAG_LABELS } from "../shared/settings";
import {
  SITES,
  type BubbleAnswer,
  type BuddyRead,
  type FeedAnswer,
  type OverlaySettings,
  type PanelRequest,
  type Status,
} from "../shared/types";
import { cleanTooltip, DEFAULT_TOOLTIP, lineOn, tipLabel, type TooltipPrefs } from "../shared/tooltip";
import { verdictFor } from "../shared/verdict";
import { bubbleMapView } from "./bubble";
import { buddyCard } from "./buddy";
import { SITE_NAMES, tokenCard } from "./card";

/**
 * The side panel: your latest alerts, each with its flags and the AI's verdict, and links to open
 * the token on Axiom, Terminal or GMGN. Connect with a key from TrenchScanner Settings. It never
 * touches the sites: a link is the only thing that leads there. Built with DOM calls only;
 * nothing here is parsed as HTML.
 */
/**
 * Settings opened to connect this browser: the page scrolls to Browser extension, finds this
 * extension by the ID given here (apps/web/src/extensionBridge.ts) and offers one click.
 */
function connectUrl(): string {
  return `https://trenchscanner.app/?connect=extension&ext=${encodeURIComponent(chrome.runtime.id)}#settings`;
}
/** How often the open panel re-reads the list. Hidden panels don't poll. */
const POLL_MS = 5_000;
/** How often Trade Buddy's coins are re-read while it shows. */
const BUDDY_POLL_MS = 10_000;
/** How often an open bubble map is re-read (the site's token view reads its maps every 30 s). */
const MAP_POLL_MS = 30_000;

const app = document.getElementById("app")!;
const account = document.getElementById("account")!;

let view: "alerts" | "buddy" | "settings" = "alerts";
let status: Status | null = null;
let feed: FeedAnswer | null = null;
let buddy: BuddyRead | null = null;
let buddyReadAt = 0;
/** What the rings' tooltip shows, kept in this browser (shared/tooltip.ts). */
let tipPrefs: TooltipPrefs = DEFAULT_TOOLTIP;
let pollTimer: number | undefined;
/** Mints already shown, so a new alert can be marked as new. */
let seen: Set<string> | null = null;
/** Cards whose "Why the AI said so" is open: the list redraws every poll and keeps them open. */
const openWhy = new Set<string>();
/** Alerts whose bubble map is open (a click on the card opens it). */
const openMaps = new Set<string>();
/** Held Trade Buddy coins whose map was closed: the rest show theirs without a click. */
const closedBuddyMaps = new Set<string>();
/** Trade Buddy coins whose trade box is open (collapsed by default). */
const openTrades = new Set<string>();

/**
 * Each coin's map, kept across redraws: the lists are rebuilt every poll, and the same node is put
 * back in the new card, so a map doesn't flicker or lose its place while it is re-read.
 */
const maps = new Map<string, { node: HTMLElement; readAt: number; loading: boolean }>();

function mapSlot(mint: string): HTMLElement {
  let entry = maps.get(mint);
  if (!entry) {
    const node = el(
      "div",
      { className: "map-slot" },
      el("p", { className: "note", textContent: "Reading the bubble map…" }),
    );
    entry = { node, readAt: 0, loading: false };
    maps.set(mint, entry);
  }
  void loadMap(mint);
  return entry.node;
}

/** Re-reads a shown map when it is due. */
async function loadMap(mint: string): Promise<void> {
  const entry = maps.get(mint);
  if (!entry || entry.loading || Date.now() - entry.readAt < MAP_POLL_MS) return;
  if (document.visibilityState !== "visible") return;
  entry.loading = true;
  try {
    const answer = await send<BubbleAnswer>({ type: "bubble", mint });
    entry.readAt = Date.now();
    if (answer?.problem === "untracked") {
      entry.node.replaceChildren(
        el("p", { className: "note", textContent: "TrenchScanner doesn't track this coin's holders." }),
      );
    } else if (answer && answer.problem === null) {
      entry.node.replaceChildren(bubbleMapView(answer.map));
    } else if (!entry.node.querySelector(".bubble")) {
      entry.node.replaceChildren(
        el("p", { className: "note", textContent: "Couldn't read the bubble map. Retrying…" }),
      );
      entry.readAt = Date.now() - MAP_POLL_MS + POLL_MS;
    }
  } finally {
    entry.loading = false;
  }
}

/** Drops the maps no longer shown, so a closed one is read fresh when opened again. */
function pruneMaps(shown: ReadonlySet<string>): void {
  for (const mint of maps.keys()) if (!shown.has(mint)) maps.delete(mint);
}

/** The card's "Bubble map" switch, and the map under the card while it is open. */
function withMap(
  card: HTMLElement,
  mint: string,
  isOpen: () => boolean,
  setOpen: (on: boolean) => void,
): void {
  const toggleMap = el("button", {
    type: "button",
    className: `map-toggle${isOpen() ? " on" : ""}`,
    textContent: isOpen() ? "Hide bubble map ▴" : "Bubble map ▾",
  });
  toggleMap.setAttribute("aria-expanded", String(isOpen()));
  const flip = () => {
    setOpen(!isOpen());
    draw();
  };
  toggleMap.addEventListener("click", (e) => {
    e.stopPropagation();
    flip();
  });
  card.append(toggleMap);
  // A click anywhere on the card that isn't a link, a button or the map itself opens it too.
  card.classList.add("clickable");
  card.addEventListener("click", (e) => {
    const target = e.target as Element | null;
    if (target?.closest("a, button, summary, details, input, .map-slot")) return;
    flip();
  });
  if (isOpen()) card.append(mapSlot(mint));
}

function send<T>(request: PanelRequest): Promise<T> {
  return chrome.runtime.sendMessage(request) as Promise<T>;
}

/** An element with plain properties (textContent, type, checked…) and children. Never innerHTML. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string | boolean> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

function section(title: string, ...children: Node[]): HTMLElement {
  return el("section", {}, el("h2", { textContent: title }), ...children);
}

function toggle(
  label: string,
  sub: string | null,
  checked: boolean,
  accent: string,
  onChange: (on: boolean) => void,
): HTMLElement {
  const input = el("input", { type: "checkbox", className: "switch", checked });
  input.style.setProperty("--accent", accent);
  input.setAttribute("aria-label", label);
  input.addEventListener("change", () => onChange(input.checked));
  const text = el("div", {}, label);
  if (sub) text.append(el("div", { className: "sub", textContent: sub }));
  return el("label", { className: "opt" }, text, input);
}

function connectButton(label = "Connect with TrenchScanner"): HTMLAnchorElement {
  return el("a", {
    href: connectUrl(),
    target: "_blank",
    rel: "noopener noreferrer",
    className: "button primary",
    textContent: label,
  });
}

function renderDisconnected(): void {
  account.textContent = "Not connected";
  account.className = "account";
  const signIn = connectButton();
  app.replaceChildren(
    section(
      "Connect your account",
      el("p", {}, "Lists the tokens your filters and models alert on, with their flags, beside any page."),
      signIn,
      el(
        "p",
        { className: "note" },
        "Opens TrenchScanner Settings at Browser extension, where one click connects this browser. This panel updates by itself. The key it gets can only read your alerts and stats.",
      ),
    ),
  );
}

function tabs(): HTMLElement {
  const make = (id: typeof view, label: string) => {
    const button = el("button", { className: `tab${view === id ? " on" : ""}`, textContent: label });
    button.setAttribute("aria-pressed", String(view === id));
    button.addEventListener("click", () => {
      view = id;
      draw();
      // Trade Buddy reads at once rather than on the next tick.
      if (id === "buddy") {
        buddyReadAt = 0;
        void poll();
      }
    });
    return button;
  };
  return el(
    "nav",
    { className: "tabs" },
    make("alerts", "Alerts"),
    make("buddy", "Trade Buddy"),
    make("settings", "Settings"),
  );
}

function alertsView(saved: OverlaySettings): HTMLElement[] {
  // Without the AI reviewer's verdicts (admins only) "only when the AI says buy" would hide every call.
  const settings = status?.aiReviews ? saved : { ...saved, rings: { ...saved.rings, aiBuyOnly: false } };
  const parts: HTMLElement[] = [];
  if (status?.problem === "refused" || feed?.problem === "refused") {
    parts.push(
      section(
        "Key refused",
        el("p", {
          className: "error",
          textContent:
            "TrenchScanner no longer takes this browser's key. Signing out of TrenchScanner disconnects the extension, and so does revoking its key or a subscription ending.",
        }),
        connectButton("Connect again"),
      ),
    );
  } else if (feed?.problem === "offline") {
    parts.push(el("p", { className: "status warn", textContent: "Can't reach TrenchScanner. Retrying…" }));
  }
  if (!feed) {
    parts.push(el("p", { className: "status", textContent: "Loading your alerts…" }));
    return parts;
  }
  const now = Date.now();
  const shown = feed.tokens
    .map((token) => ({ token, verdict: verdictFor(token, settings) }))
    .filter(({ verdict }) => verdict.ring !== null && verdict.ring !== "risk");
  if (shown.length === 0) {
    parts.push(
      el("p", {
        className: "status",
        textContent: "No alerts in the last 6 hours. New ones from your filters and models appear here.",
      }),
    );
    return parts;
  }
  const list = el("div", { className: "list" });
  for (const { token, verdict } of shown) {
    const card = tokenCard(token, verdict, settings, now);
    const why = card.querySelector("details");
    if (why) {
      why.open = openWhy.has(token.mint);
      why.addEventListener("toggle", () => (why.open ? openWhy.add(token.mint) : openWhy.delete(token.mint)));
    }
    if (seen && !seen.has(token.mint)) card.classList.add("new");
    if (verdict.risky && settings.rings.riskRing) card.classList.add("risky");
    withMap(
      card,
      token.mint,
      () => openMaps.has(token.mint),
      (on) => (on ? openMaps.add(token.mint) : openMaps.delete(token.mint)),
    );
    list.append(card);
  }
  pruneMaps(new Set(shown.map(({ token }) => token.mint).filter((m) => openMaps.has(m))));
  seen = new Set(feed.tokens.map((t) => t.mint));
  parts.push(list);
  return parts;
}

function buddyView(settings: OverlaySettings): HTMLElement[] {
  const parts: HTMLElement[] = [];
  if (buddy?.problem === "offline") {
    parts.push(el("p", { className: "status warn", textContent: "Can't reach TrenchScanner. Retrying…" }));
  }
  const answer = buddy?.buddy ?? null;
  if (!answer) {
    parts.push(el("p", { className: "status", textContent: "Reading your wallet's trades…" }));
    return parts;
  }
  if (answer.coins.length === 0) {
    parts.push(
      section(
        "Trade Buddy",
        el("p", {
          textContent:
            "Coins your connected wallet buys show up here, from any site you trade on, with their token card, bubble map and your PnL.",
        }),
        el("p", {
          className: "note",
          textContent:
            "Held coins stay listed; sold ones for a day. Trades are read from the chain, usually within seconds.",
        }),
      ),
    );
    return parts;
  }
  const now = Date.now();
  const list = el("div", { className: "list" });
  const shownMaps = new Set<string>();
  for (const coin of answer.coins) {
    const card = buddyCard(coin, settings, answer.pro, now);
    const why = card.querySelector("details.why") as HTMLDetailsElement | null;
    if (why) {
      why.open = openWhy.has(coin.mint);
      why.addEventListener("toggle", () => (why.open ? openWhy.add(coin.mint) : openWhy.delete(coin.mint)));
    }
    const trade = card.querySelector("details.trade") as HTMLDetailsElement | null;
    if (trade) {
      trade.open = openTrades.has(coin.mint);
      trade.addEventListener("toggle", () =>
        trade.open ? openTrades.add(coin.mint) : openTrades.delete(coin.mint),
      );
    }
    // A held coin's map shows by itself; a sold one's on a click.
    const isOpen = () => (coin.closed ? openMaps.has(coin.mint) : !closedBuddyMaps.has(coin.mint));
    withMap(card, coin.mint, isOpen, (on) => {
      const set = coin.closed ? openMaps : closedBuddyMaps;
      // A sold coin's set lists open maps; a held coin's, closed ones.
      if (on === coin.closed) set.add(coin.mint);
      else set.delete(coin.mint);
    });
    if (isOpen()) shownMaps.add(coin.mint);
    // The trade box sits last, under the map.
    if (trade) card.append(trade);
    list.append(card);
  }
  pruneMaps(shownMaps);
  parts.push(list);
  if (answer.solUsd !== null)
    parts.push(
      el("p", {
        className: "note pad",
        textContent: `PnL in SOL at $${Math.round(answer.solUsd)} a SOL, as TrenchScanner's Portfolio prices it.`,
      }),
    );
  return parts;
}

function settingsView(current: OverlaySettings): HTMLElement[] {
  const settings: OverlaySettings = structuredClone(current);
  const save = () => {
    if (status) status.settings = structuredClone(settings);
    void send({ type: "saveSettings", settings });
  };
  const parts: HTMLElement[] = [];
  parts.push(
    section(
      "Show",
      toggle(
        "Model alerts",
        "Your followed models' calls",
        settings.rings.modelAlerts,
        "var(--model)",
        (on) => {
          settings.rings.modelAlerts = on;
          save();
        },
      ),
      toggle("Filter matches", "Your active filters", settings.rings.filterMatches, "var(--filter)", (on) => {
        settings.rings.filterMatches = on;
        save();
      }),
      ...(status?.aiReviews
        ? [
            toggle(
              "Only when the AI says buy",
              "For model alerts",
              settings.rings.aiBuyOnly,
              "var(--model)",
              (on) => {
                settings.rings.aiBuyOnly = on;
                save();
              },
            ),
          ]
        : []),
      toggle("Red edge past a flag's limit", null, settings.rings.riskRing, "var(--risk)", (on) => {
        settings.rings.riskRing = on;
        save();
      }),
    ),
  );

  const flags = FLAG_IDS.map((id) => {
    const pref = settings.flags[id];
    const meta = FLAG_LABELS[id];
    const box = el("input", { type: "checkbox", className: "switch", checked: pref.on });
    box.style.setProperty("--accent", "var(--risk)");
    box.setAttribute("aria-label", meta.label);
    box.addEventListener("change", () => {
      pref.on = box.checked;
      save();
    });
    const row = el("div", { className: "flag" }, box, el("span", { textContent: meta.label }));
    if (pref.threshold === null) row.append(el("span"));
    else {
      const limit = el("input", { type: "number", min: "0", step: "1", value: String(pref.threshold) });
      limit.setAttribute("aria-label", `${meta.label} limit`);
      limit.addEventListener("change", () => {
        const value = Number(limit.value);
        if (Number.isFinite(value) && value >= 0) {
          pref.threshold = value;
          save();
        }
      });
      row.append(limit);
    }
    return row;
  });
  parts.push(section("Flags, with limits", ...flags));

  const sites = el(
    "div",
    { className: "sites" },
    ...SITES.map((site) => {
      const box = el("input", { type: "checkbox", checked: settings.sites[site] });
      box.addEventListener("change", () => {
        settings.sites[site] = box.checked;
        save();
      });
      return el("label", {}, box, SITE_NAMES[site]);
    }),
  );
  parts.push(section("Open tokens on", sites));
  parts.push(tooltipSection(settings));

  const disconnect = el("button", { className: "link", textContent: "Disconnect this browser" });
  disconnect.addEventListener("click", async () => {
    await send({ type: "disconnect" });
    feed = null;
    buddy = null;
    seen = null;
    maps.clear();
    void refresh();
  });
  parts.push(
    section(
      "Account",
      el("p", {
        className: "note",
        textContent:
          "This rings build reads the token addresses on Axiom, Terminal and GMGN boards to ring your alerts. It never reads your logins, and no address leaves the browser except an alerted coin's, for its map totals.",
      }),
      disconnect,
    ),
  );
  return parts;
}

/**
 * Rings build: which lines the tooltip on a ringed row shows, and their order. A flag's line
 * follows its switch above until it is picked here.
 */
function tooltipSection(settings: OverlaySettings): HTMLElement {
  const save = () => void send({ type: "saveTooltip", prefs: tipPrefs });
  const box = section("Ring tooltip");
  const list = el("div", { className: "tiplines" });
  const fill = () => {
    list.replaceChildren(
      ...tipPrefs.order.map((line, i) => {
        const label = tipLabel(line);
        const on = el("input", {
          type: "checkbox",
          className: "switch",
          checked: lineOn(line, tipPrefs, settings),
        });
        on.setAttribute("aria-label", `Show ${label}`);
        on.addEventListener("change", () => {
          tipPrefs = { ...tipPrefs, on: { ...tipPrefs.on, [line]: on.checked } };
          save();
        });
        const move = (by: number, glyph: string, name: string) => {
          const b = el("button", {
            className: "move",
            textContent: glyph,
            disabled: i + by < 0 || i + by >= tipPrefs.order.length,
          });
          b.setAttribute("aria-label", `Move ${label} ${name}`);
          b.addEventListener("click", () => {
            const order = [...tipPrefs.order];
            [order[i], order[i + by]] = [order[i + by]!, order[i]!];
            tipPrefs = { ...tipPrefs, order };
            save();
            fill();
            (
              list.children[i + by]?.querySelectorAll("button.move")[by < 0 ? 0 : 1] as
                HTMLElement | undefined
            )?.focus();
          });
          return b;
        };
        return el(
          "div",
          { className: "tipline" },
          on,
          el("span", { textContent: label }),
          move(-1, "↑", "up"),
          move(1, "↓", "down"),
        );
      }),
    );
  };
  fill();
  const reset = el("button", { className: "link", textContent: "Reset to default" });
  reset.addEventListener("click", () => {
    tipPrefs = DEFAULT_TOOLTIP;
    save();
    fill();
  });
  box.append(
    el("p", {
      className: "note",
      textContent:
        "Lines shown when you point at a ring's badge, top to bottom. Alerts, stats and the footer keep their own groups.",
    }),
    list,
    reset,
  );
  return box;
}

function draw(): void {
  if (!status?.connected) {
    renderDisconnected();
    return;
  }
  // Either answer may be the first to see a refused key.
  const refused = status.problem === "refused" || feed?.problem === "refused";
  account.textContent = refused ? "Reconnect needed" : `Connected · ${status.wallet ?? ""}`;
  account.className = refused ? "account warn" : "account on";
  const settings = status.settings;
  const body =
    view === "alerts"
      ? alertsView(settings)
      : view === "buddy"
        ? buddyView(settings)
        : settingsView(settings);
  app.replaceChildren(tabs(), ...body);
}

async function poll(): Promise<void> {
  window.clearTimeout(pollTimer);
  if (document.visibilityState === "visible" && status?.connected) {
    // Status too: settings saved from another browser, or a key refused since the last poll.
    const wantBuddy = view === "buddy" && Date.now() - buddyReadAt >= BUDDY_POLL_MS;
    if (wantBuddy) buddyReadAt = Date.now();
    const [nextStatus, nextFeed, nextBuddy] = await Promise.all([
      send<Status>({ type: "status" }),
      view === "alerts" || !feed ? send<FeedAnswer>({ type: "feed" }) : Promise.resolve(null),
      wantBuddy ? send<BuddyRead>({ type: "buddy" }) : Promise.resolve(null),
    ]);
    status = nextStatus ?? status;
    feed = nextFeed ?? feed;
    buddy = nextBuddy ?? buddy;
    // Settings edits redraw only when left, so an input in focus isn't replaced under the cursor.
    if (view !== "settings") draw();
    for (const mint of maps.keys()) void loadMap(mint);
  }
  pollTimer = window.setTimeout(() => void poll(), POLL_MS);
}

async function refresh(): Promise<void> {
  status = await send<Status>({ type: "status" });
  tipPrefs = cleanTooltip(await send<TooltipPrefs>({ type: "tooltip" }));
  draw();
  if (status?.connected) await poll();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void poll();
});

// TrenchScanner's Settings handed over a key while the panel was open.
chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if (sender.id !== chrome.runtime.id) return;
  if ((message as { type?: unknown } | null)?.type === "connected") {
    view = "alerts";
    feed = null;
    buddy = null;
    seen = null;
    maps.clear();
    void refresh();
  }
});

void refresh();
