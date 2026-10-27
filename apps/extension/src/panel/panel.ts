import { FLAG_IDS, FLAG_LABELS } from "../shared/settings";
import {
  SITES,
  type BuddyRead,
  type CoinAnswer,
  type FeedAnswer,
  type OverlaySettings,
  type PanelRequest,
  type Status,
} from "../shared/types";
import {
  cleanTooltip,
  COLOR_KEYS,
  type ColorKey,
  COLOR_LABELS,
  colorsOf,
  DEFAULT_COLORS,
  DEFAULT_TOOLTIP,
  EFFECT_LABELS,
  lineOn,
  RING_EFFECTS,
  type RingEffect,
  signalLook,
  type SafetyMode,
  type SignalKey,
  type SignalStyle,
  partOn,
  pillLabel,
  tipLabel,
  type ListPrefs,
  type PillPart,
  toastPartOn,
  type TipLine,
  type ToastPrefs,
  type TooltipPrefs,
  LIMIT_IDS,
  type LimitMode,
  MAX_BUDDY_WALLETS,
  RUN_LEVELS,
  snoozed,
} from "../shared/tooltip";
import { isMintAddress } from "../shared/mint";
import { verdictFor } from "../shared/verdict";
import { siteMapNode } from "../map/siteMap";
import { BOARD_COLUMNS, type BoardColumn } from "../content/columns";
import { buddyCard, shortWallet, summaryBlock } from "./buddy";
import { scorecard, SITE_NAMES, tokenCard } from "./card";
import { holderList, mintFrom } from "./coin";
import { panelAlerts } from "../shared/alerts";

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
/** How often Trade Buddy's coins are re-read while it shows (the API reuses an answer for 8 s). */
const BUDDY_POLL_MS = 5_000;

const app = document.getElementById("app")!;
const account = document.getElementById("account")!;

let view: "alerts" | "buddy" | "coin" | "settings" = "alerts";
/** The lookup's coin and its answer (null while it is read). */
let coin: { mint: string; answer: CoinAnswer | null } | null = null;
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
 * back in the new card, so a map doesn't flicker or lose its place. The map is the site's own
 * (map/siteMap.ts), which follows the coin live by itself.
 */
const maps = new Map<string, { node: HTMLElement; stop: () => void }>();

function mapSlot(mint: string): HTMLElement {
  let entry = maps.get(mint);
  if (!entry) {
    entry = siteMapNode(mint);
    maps.set(mint, entry);
  }
  return entry.node;
}

/** Drops the maps no longer shown, so a closed one stops reading and starts fresh when opened again. */
function pruneMaps(shown: ReadonlySet<string>): void {
  for (const [mint, entry] of maps) {
    if (shown.has(mint)) continue;
    entry.stop();
    maps.delete(mint);
  }
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
        "Opens TrenchScanner Settings at Browser extension, where one click connects this browser. This panel updates by itself. The key it gets reads your alerts and stats, coins' bubble maps, and your wallet's own trades for Trade Buddy. It can't trade or move funds.",
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
      // Trade Buddy reads at once rather than on the next tick, unless a read just went out.
      if (id === "buddy" && Date.now() - buddyReadAt >= 2_000) {
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
    make("coin", "Look up"),
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
  const listed = panelAlerts(feed.tokens, settings, tipPrefs.panel);
  // Snoozed coins sit out until they wake (user ask 2026-10-27); Settings can wake them early.
  const shown = listed.filter(({ token }) => !snoozed(tipPrefs, token.mint, now));
  const score = scorecard(listed.map(({ token }) => token));
  if (score) parts.push(score);
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
    const card = tokenCard(token, verdict, settings, now, undefined, snoozeCoin);
    paintSignal(card, verdict);
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
  // Shown means read: the toolbar icon's count of unread alerts clears.
  if (document.visibilityState === "visible")
    void send({ type: "alertsSeen", mints: shown.map(({ token }) => token.mint) });
  parts.push(list);
  return parts;
}

/** Snoozes a coin from its card: the worker saves it, and every page and this panel redraw. */
function snoozeCoin(mint: string, minutes: number): void {
  const until = Date.now() + minutes * 60_000;
  tipPrefs = { ...tipPrefs, snoozed: { ...tipPrefs.snoozed, [mint]: until } };
  draw();
  void send({ type: "snooze", mint, minutes });
}

/** A card wears its model's or filter's own colour, where the reader picked one (Settings). */
function paintSignal(card: HTMLElement, verdict: { modelId: string | null; filterId: string | null }): void {
  const { colors } = signalLook(tipPrefs, verdict.modelId, verdict.filterId);
  card.style.setProperty("--model", colors.model);
  card.style.setProperty("--filter", colors.filter);
}

/**
 * Look up (user ask 2026-10-25): any coin by its address or a link to it, with its card, bubble
 * map and top holders tagged as the holder markers tag them. Redrawn only by its own reads, so
 * the address box keeps its text and focus.
 */
function coinView(settings: OverlaySettings): HTMLElement[] {
  const input = el("input", {
    type: "text",
    placeholder: "Paste a coin address or a link to one",
    value: coin?.mint ?? "",
    spellcheck: false,
  });
  input.setAttribute("aria-label", "Coin address");
  const go = el("button", { type: "submit", className: "button primary", textContent: "Look up" });
  const form = el("form", { className: "lookup" }, input, go);
  const parts: HTMLElement[] = [form];
  const problem = el("p", { className: "status warn" });
  problem.hidden = true;
  parts.push(problem);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const mint = mintFrom(input.value);
    if (!mint) {
      problem.textContent = "That isn't a Solana coin address.";
      problem.hidden = false;
      return;
    }
    void lookUp(mint);
  });
  if (!coin) {
    pruneMaps(new Set());
    parts.push(
      el("p", {
        className: "status",
        textContent:
          "Any coin, alerted or not: its card, safety screen, bubble map and top holders, with TrenchScanner's cluster, sniper, fresh-wallet and dev tags.",
      }),
    );
    return parts;
  }
  pruneMaps(new Set([coin.mint]));
  const answer = coin.answer;
  if (!answer) {
    parts.push(el("p", { className: "status", textContent: "Reading the coin…" }));
    return parts;
  }
  if (answer.problem === "offline")
    parts.push(el("p", { className: "status warn", textContent: "Can't reach TrenchScanner. Try again." }));
  const list = el("div", { className: "list" });
  if (answer.token) {
    const verdict = verdictFor(answer.token, settings);
    const card = tokenCard(answer.token, verdict, settings);
    paintSignal(card, verdict);
    list.append(card);
  } else {
    list.append(
      el("p", {
        className: "note",
        textContent: "TrenchScanner hasn't stored this coin yet. Its map below starts a scan.",
      }),
    );
  }
  list.append(mapSlot(coin.mint));
  if (answer.map && answer.map.holders.length > 0)
    list.append(section("Top holders", holderList(answer.map, colorsOf(tipPrefs))));
  parts.push(list);
  return parts;
}

async function lookUp(mint: string): Promise<void> {
  coin = { mint, answer: null };
  draw();
  const answer = await send<CoinAnswer>({ type: "coin", mint });
  if (coin?.mint !== mint) return;
  coin = { mint, answer: answer ?? { token: null, map: null, problem: "offline" } };
  if (view === "coin") draw();
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
            "Held coins stay listed; sold ones for a day. Trades are read from the chain, usually within seconds. Trading from Axiom's, Terminal's or another wallet? Add it in Settings → Trade Buddy wallets.",
        }),
      ),
    );
    return parts;
  }
  const now = Date.now();
  if (answer.summary && answer.summary.trades > 0) parts.push(summaryBlock(answer.summary));
  const list = el("div", { className: "list" });
  const shownMaps = new Set<string>();
  for (const coin of answer.coins) {
    const card = buddyCard(coin, settings, answer.pro, now, answer.wallets ?? []);
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

  parts.push(panelSection(), runsSection(), buddyWalletsSection());

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
  // The store build has nothing on the sites' pages, so none of their settings (build.mjs --store).
  parts.push(...(__STORE__ ? [signalSection(), colorSection()] : ringDisplaySections(settings)));

  const disconnect = el("button", { className: "link", textContent: "Disconnect this browser" });
  disconnect.addEventListener("click", async () => {
    await send({ type: "disconnect" });
    feed = null;
    buddy = null;
    seen = null;
    pruneMaps(new Set());
    void refresh();
  });
  parts.push(
    section(
      "Account",
      el("p", {
        className: "note",
        textContent: __STORE__
          ? "This extension never runs on any website. It can't see your exchange pages, logins or wallet apps. It only talks to TrenchScanner, with a key you can revoke from TrenchScanner's Settings."
          : "This version reads the token addresses on Axiom, Terminal and GMGN boards to ring your alerts. It never reads your logins. No address leaves the browser except an alerted coin's, for its map totals, the coin page you open, for its map and holder markers, and, only while the safety screen or the pill on every coin is on, the coins on the board.",
      }),
      disconnect,
    ),
  );
  return parts;
}

/**
 * An ordered list of switches with up and down buttons: the tooltip's lines and each pill's parts.
 * `get` reads the current list from tipPrefs, `put` stores a changed one there.
 */
function orderedList<T extends string>(
  get: () => ListPrefs<T>,
  put: (list: ListPrefs<T>) => void,
  isOn: (item: T) => boolean,
  label: (item: T) => string,
): { list: HTMLElement; fill: () => void } {
  const list = el("div", { className: "tiplines" });
  const save = () => void send({ type: "saveTooltip", prefs: tipPrefs });
  const fill = () => {
    const current = get();
    list.replaceChildren(
      ...current.order.map((item, i) => {
        const name = label(item);
        const on = el("input", { type: "checkbox", className: "switch", checked: isOn(item) });
        on.setAttribute("aria-label", `Show ${name}`);
        on.addEventListener("change", () => {
          const now = get();
          put({ ...now, on: { ...now.on, [item]: on.checked } });
          save();
        });
        const move = (by: number, glyph: string, where: string) => {
          const b = el("button", {
            className: "move",
            textContent: glyph,
            disabled: i + by < 0 || i + by >= current.order.length,
          });
          b.setAttribute("aria-label", `Move ${name} ${where}`);
          b.addEventListener("click", () => {
            const now = get();
            const order = [...now.order];
            [order[i], order[i + by]] = [order[i + by]!, order[i]!];
            put({ ...now, order });
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
          el("span", { textContent: name }),
          move(-1, "↑", "up"),
          move(1, "↓", "down"),
        );
      }),
    );
  };
  fill();
  return { list, fill };
}

/**
 * Rings: what each ring's pill says, an optional second pill, and the tooltip's lines, each
 * in the reader's order. Kept in this browser (shared/tooltip.ts).
 */
function ringDisplaySections(settings: OverlaySettings): HTMLElement[] {
  const save = () => void send({ type: "saveTooltip", prefs: tipPrefs });
  const reset = (what: string, apply: () => void, refill: () => void) => {
    const b = el("button", { className: "link", textContent: `Reset ${what}` });
    b.addEventListener("click", () => {
      apply();
      save();
      refill();
    });
    return b;
  };

  const pill = orderedList<PillPart>(
    () => tipPrefs.pill,
    (list) => (tipPrefs = { ...tipPrefs, pill: list }),
    (part) => partOn(part, tipPrefs.pill, false),
    pillLabel,
  );
  const dot = toggle("Red dot past a flag's limit", null, tipPrefs.riskDot, "var(--risk)", (on) => {
    tipPrefs = { ...tipPrefs, riskDot: on };
    save();
  });
  const pillBox = section(
    "Ring pill",
    el("p", {
      className: "note",
      textContent: "What the pill on a ring says, left to right. With nothing on, it's just the dot.",
    }),
    dot,
    pill.list,
    reset(
      "pill",
      () => {
        tipPrefs = { ...tipPrefs, pill: DEFAULT_TOOLTIP.pill, riskDot: true };
        dot.querySelector("input")!.checked = true;
      },
      pill.fill,
    ),
  );

  const second = orderedList<PillPart>(
    () => tipPrefs.second,
    (list) => (tipPrefs = { ...tipPrefs, second: { ...list, enabled: tipPrefs.second.enabled } }),
    (part) => partOn(part, tipPrefs.second, true),
    pillLabel,
  );
  second.list.hidden = !tipPrefs.second.enabled;
  const secondBox = section(
    "Second pill",
    toggle(
      "Show a second pill",
      "More of the coin's numbers beside the first",
      tipPrefs.second.enabled,
      "var(--filter)",
      (on) => {
        tipPrefs = { ...tipPrefs, second: { ...tipPrefs.second, enabled: on } };
        second.list.hidden = !on;
        save();
      },
    ),
    second.list,
  );

  const tip = orderedList<TipLine>(
    () => tipPrefs,
    (list) => (tipPrefs = { ...tipPrefs, ...list }),
    (line) => lineOn(line, tipPrefs, settings),
    tipLabel,
  );
  const tipBox = section(
    "Ring tooltip",
    el("p", {
      className: "note",
      textContent:
        "Lines shown when you point at a ring's pill, top to bottom. Alerts, stats and the footer keep their own groups.",
    }),
    tip.list,
    reset("tooltip", () => (tipPrefs = { ...tipPrefs, order: DEFAULT_TOOLTIP.order, on: {} }), tip.fill),
  );
  const boardAge = el("input", {
    type: "number",
    min: "1",
    max: "1440",
    step: "1",
    value: String(tipPrefs.boardStats.maxAgeMinutes),
  });
  boardAge.setAttribute("aria-label", "Only numbers this many minutes old or newer");
  boardAge.addEventListener("change", () => {
    const n = Math.round(Number(boardAge.value));
    if (!Number.isFinite(n) || n < 1 || n > 1440) {
      boardAge.value = String(tipPrefs.boardStats.maxAgeMinutes);
      return;
    }
    tipPrefs = { ...tipPrefs, boardStats: { ...tipPrefs.boardStats, maxAgeMinutes: n } };
    save();
  });
  const boardBox = section(
    "Pill on every coin",
    toggle(
      "Show the pill on coins that aren't alerts",
      "The same parts as the ring pill, in grey with no ring, on every coin TrenchScanner has fresh numbers for. Sends the board's addresses to TrenchScanner while on.",
      tipPrefs.boardStats.enabled,
      "var(--filter)",
      (on) => {
        tipPrefs = { ...tipPrefs, boardStats: { ...tipPrefs.boardStats, enabled: on } };
        save();
      },
    ),
    el("label", { className: "opt" }, el("div", {}, "Only numbers at most this many minutes old"), boardAge),
  );
  return [
    pillBox,
    secondBox,
    boardBox,
    limitsSection(),
    tipBox,
    toastSection(),
    safetySection(),
    mapTabSection(),
    signalSection(),
    colorSection(),
  ];
}

/** Rings: the on-page alert, off by default, every part of it the reader's. */
function toastSection(): HTMLElement {
  const save = () => void send({ type: "saveTooltip", prefs: tipPrefs });
  const set = (change: Partial<ToastPrefs>) => {
    tipPrefs = { ...tipPrefs, toast: { ...tipPrefs.toast, ...change } };
    save();
  };
  const t = () => tipPrefs.toast;
  const number = (label: string, value: number, min: number, max: number, apply: (n: number) => void) => {
    const input = el("input", {
      type: "number",
      min: String(min),
      max: String(max),
      step: "1",
      value: String(value),
    });
    input.setAttribute("aria-label", label);
    input.addEventListener("change", () => {
      const n = Number(input.value);
      if (Number.isFinite(n) && n >= min && n <= max) apply(Math.round(n));
      else input.value = String(value);
    });
    return el("label", { className: "flag" }, el("span"), el("span", { textContent: label }), input);
  };
  const choice = <T extends string>(
    label: string,
    value: T,
    options: readonly [T, string][],
    apply: (v: T) => void,
  ) => {
    const select = el(
      "select",
      {},
      ...options.map(([v, text]) => el("option", { value: v, textContent: text, selected: v === value })),
    );
    select.setAttribute("aria-label", label);
    select.addEventListener("change", () => apply(select.value as T));
    return el("label", { className: "pick" }, el("span", { textContent: label }), select);
  };
  const sites = el(
    "div",
    { className: "sites" },
    ...SITES.map((site) => {
      const box = el("input", { type: "checkbox", checked: t().sites[site] });
      box.addEventListener("change", () => set({ sites: { ...t().sites, [site]: box.checked } }));
      return el("label", {}, box, SITE_NAMES[site]);
    }),
  );
  const parts = orderedList<PillPart>(
    () => t().parts,
    (list) => (tipPrefs = { ...tipPrefs, toast: { ...t(), parts: list } }),
    (part) => toastPartOn(part, t().parts),
    pillLabel,
  );
  const details = el(
    "div",
    { className: "toastopts" },
    toggle("Model alerts", null, t().models, "var(--model)", (on) => set({ models: on })),
    toggle("Filter matches", null, t().filters, "var(--filter)", (on) => set({ filters: on })),
    ...(status?.aiReviews
      ? [
          toggle("Only when the AI says buy", "For model alerts", t().aiBuyOnly, "var(--model)", (on) =>
            set({ aiBuyOnly: on }),
          ),
        ]
      : []),
    number("Model odds to 2x at least (%)", t().minOdds, 0, 100, (n) => set({ minOdds: n })),
    choice(
      "Where",
      t().position,
      [
        ["top-right", "Top right"],
        ["top-left", "Top left"],
        ["bottom-right", "Bottom right"],
        ["bottom-left", "Bottom left"],
      ],
      (v) => set({ position: v }),
    ),
    number("Seconds on screen (0 keeps it)", t().seconds, 0, 600, (n) => set({ seconds: n })),
    number("At most on screen", t().maxShown, 1, 10, (n) => set({ maxShown: n })),
    toggle("Sound", null, t().sound, "var(--filter)", (on) => set({ sound: on })),
    choice(
      "A click",
      t().click,
      [
        ["site", "Opens the coin on that site"],
        ["trenchscanner", "Opens it on TrenchScanner"],
        ["none", "Does nothing"],
      ],
      (v) => set({ click: v }),
    ),
    el("div", { className: "sub", textContent: "On" }),
    sites,
    el("div", { className: "sub", textContent: "What it says" }),
    parts.list,
  );
  details.hidden = !t().enabled;
  return section(
    "On-page alerts",
    toggle(
      "Show a toast on the board",
      "When a new alert lands in your feed",
      t().enabled,
      "var(--model)",
      (on) => {
        set({ enabled: on });
        details.hidden = !on;
      },
    ),
    details,
  );
}

/** A labelled drop-down. */
function pick<T extends string>(
  label: string,
  value: T,
  options: readonly [T, string][],
  apply: (v: T) => void,
): HTMLElement {
  const select = el(
    "select",
    {},
    ...options.map(([v, text]) => el("option", { value: v, textContent: text, selected: v === value })),
  );
  select.setAttribute("aria-label", label);
  select.addEventListener("change", () => apply(select.value as T));
  return el("label", { className: "pick" }, el("span", { textContent: label }), select);
}

const COLUMN_NAMES: Record<BoardColumn, string> = {
  new: "New",
  soon: "About to graduate",
  graduated: "Graduated",
  other: "Trending and other lists",
};

/** Rings: coins failing the safety screen on the boards, off by default. */
function safetySection(): HTMLElement {
  const columns = el(
    "div",
    { className: "sites columns" },
    ...BOARD_COLUMNS.map((column) => {
      const box = el("input", { type: "checkbox", checked: tipPrefs.safety.columns[column] });
      box.addEventListener("change", () => {
        tipPrefs = {
          ...tipPrefs,
          safety: { ...tipPrefs.safety, columns: { ...tipPrefs.safety.columns, [column]: box.checked } },
        };
        void send({ type: "saveTooltip", prefs: tipPrefs });
      });
      return el("label", {}, box, COLUMN_NAMES[column]);
    }),
  );
  columns.hidden = tipPrefs.safety.mode === "off";
  return section(
    "Safety screen on the boards",
    pick<SafetyMode>(
      "Coins failing it",
      tipPrefs.safety.mode,
      [
        ["off", "Show as usual"],
        ["hide", "Hide them"],
        ["mark", "Mark them with an X"],
      ],
      (mode) => {
        tipPrefs = { ...tipPrefs, safety: { ...tipPrefs.safety, mode } };
        void send({ type: "saveTooltip", prefs: tipPrefs });
        columns.hidden = mode === "off";
      },
    ),
    columns,
    el("p", {
      className: "note",
      textContent:
        "On Pulse, Trenches, Discover and Trending: a coin whose newest TrenchScanner scan fails the safety screen is hidden or marked, and shows again once a scan passes it. Coins TrenchScanner hasn't scanned stay as they are. While this is on, the addresses on the board are sent to TrenchScanner to ask.",
    }),
  );
}

/** Rings: the bubble map tab and the holder markers on a coin's page. */
function mapTabSection(): HTMLElement {
  return section(
    "On a coin's page",
    toggle(
      "Bubble map tab",
      "Adds a Bubble map tab beside Top Traders. It asks TrenchScanner about the coin you open.",
      tipPrefs.mapTab.enabled,
      "var(--filter)",
      (on) => {
        tipPrefs = { ...tipPrefs, mapTab: { enabled: on } };
        void send({ type: "saveTooltip", prefs: tipPrefs });
      },
    ),
    toggle(
      "Holder markers",
      "Marks the top holders the bubble map knows of (cluster, same-minute, sniper, fresh, CEX, dev-tied) wherever the page names them. A marker opens the map.",
      tipPrefs.holderMarks.enabled,
      "var(--filter)",
      (on) => {
        tipPrefs = { ...tipPrefs, holderMarks: { enabled: on } };
        void send({ type: "saveTooltip", prefs: tipPrefs });
      },
    ),
  );
}

/** The models and filters to style: those in the feed now, and those already given a look. */
export function signalChoices(
  tokens: readonly {
    modelCalls: { model: string; name: string | null }[];
    filterMatches: { filterId: string; filterName: string }[];
  }[],
  styled: Partial<Record<SignalKey, SignalStyle>>,
): { key: SignalKey; name: string; kind: "model" | "filter" }[] {
  const out = new Map<SignalKey, { key: SignalKey; name: string; kind: "model" | "filter" }>();
  for (const t of tokens) {
    for (const c of t.modelCalls)
      out.set(`model:${c.model}`, { key: `model:${c.model}`, name: c.name ?? c.model, kind: "model" });
    for (const m of t.filterMatches)
      out.set(`filter:${m.filterId}`, { key: `filter:${m.filterId}`, name: m.filterName, kind: "filter" });
  }
  for (const [key, style] of Object.entries(styled) as [SignalKey, SignalStyle][]) {
    if (out.has(key)) continue;
    const kind = key.startsWith("model:") ? "model" : "filter";
    out.set(key, { key, name: style.name ?? key.slice(kind.length + 1), kind });
  }
  return [...out.values()].sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "model" ? -1 : 1,
  );
}

/** The panel's own options: unsafe alerts left out, notifications and the icon's count. */
function panelSection(): HTMLElement {
  const put = (change: Partial<TooltipPrefs["panel"]>) => {
    tipPrefs = { ...tipPrefs, panel: { ...tipPrefs.panel, ...change } };
    void send({ type: "saveTooltip", prefs: tipPrefs });
  };
  return section(
    "Alerts",
    toggle(
      "Hide coins failing the safety screen",
      "On their newest TrenchScanner scan. They come back once a scan passes them.",
      tipPrefs.panel.hideUnsafe,
      "var(--risk)",
      (on) => put({ hideUnsafe: on }),
    ),
    toggle(
      "Notify me of new alerts",
      "A Chrome notification for each, even with the panel closed. A click opens the coin on TrenchScanner.",
      tipPrefs.panel.notify,
      "var(--model)",
      (on) => put({ notify: on }),
    ),
    toggle(
      "Unread count on the toolbar icon",
      "Alerts you haven't seen in the panel yet",
      tipPrefs.panel.badge,
      "var(--filter)",
      (on) => put({ badge: on }),
    ),
    ...snoozedRow(),
  );
}

/** How many coins are snoozed, and a button that wakes them all. */
function snoozedRow(): HTMLElement[] {
  const count = Object.keys(tipPrefs.snoozed).filter((m) => snoozed(tipPrefs, m)).length;
  if (count === 0) return [];
  const wake = el("button", { className: "link", textContent: "Wake them all" });
  wake.addEventListener("click", () => {
    tipPrefs = { ...tipPrefs, snoozed: {} };
    void send({ type: "saveTooltip", prefs: tipPrefs });
    wake.disabled = true;
    wake.textContent = "Woken";
  });
  return [
    el("p", { className: "note", textContent: `${count} coin${count === 1 ? "" : "s"} snoozed. ` }, wake),
  ];
}

/**
 * Run alerts (user ask 2026-10-27): a notification when an alert reaches 2x, 3x, 5x or 10x its
 * alert's market cap, and when it falls a set share below it. In both builds.
 */
function runsSection(): HTMLElement {
  const put = (change: Partial<TooltipPrefs["runs"]>) => {
    tipPrefs = { ...tipPrefs, runs: { ...tipPrefs.runs, ...change } };
    void send({ type: "saveTooltip", prefs: tipPrefs });
  };
  const levels = el(
    "div",
    { className: "sites" },
    ...RUN_LEVELS.map((level) => {
      const box = el("input", { type: "checkbox", checked: tipPrefs.runs.levels[level] });
      box.addEventListener("change", () =>
        put({ levels: { ...tipPrefs.runs.levels, [level]: box.checked } }),
      );
      return el("label", {}, box, `${level}x`);
    }),
  );
  const drop = el("input", {
    type: "number",
    min: "0",
    max: "95",
    step: "5",
    value: String(tipPrefs.runs.dropPct),
  });
  drop.setAttribute("aria-label", "Notify when down this many percent from the alert; 0 for never");
  drop.addEventListener("change", () => {
    const n = Math.round(Number(drop.value));
    if (!Number.isFinite(n) || n < 0 || n > 95) {
      drop.value = String(tipPrefs.runs.dropPct);
      return;
    }
    put({ dropPct: n });
  });
  return section(
    "Run alerts",
    toggle(
      "Notify me when an alert runs",
      "A Chrome notification when one of your alerts peaks at these multiples of its alert's market cap, each once. A peak isn't a win: the leaderboard counts 2x within 15 minutes of the alert, before a 50% drop.",
      tipPrefs.runs.enabled,
      "var(--ok)",
      (on) => put({ enabled: on }),
    ),
    levels,
    el(
      "label",
      { className: "opt" },
      el("div", {}, "Also when it's down this many % from its alert (0 for never)"),
      drop,
    ),
  );
}

/**
 * The reader's other wallets for Trade Buddy (user ask 2026-10-27): trades made from Axiom's,
 * Terminal's or any other wallet of theirs show up too. Public addresses only, three at most.
 */
function buddyWalletsSection(): HTMLElement {
  const save = () => {
    void send({ type: "saveTooltip", prefs: tipPrefs });
    buddyReadAt = 0;
  };
  const list = el("div", { className: "wallets" });
  const fill = () => {
    list.replaceChildren(
      ...tipPrefs.buddyWallets.map((wallet) => {
        const remove = el("button", { className: "link", textContent: "Remove" });
        remove.addEventListener("click", () => {
          tipPrefs = { ...tipPrefs, buddyWallets: tipPrefs.buddyWallets.filter((w) => w !== wallet) };
          save();
          fill();
        });
        const code = el("code", { textContent: shortWallet(wallet), title: wallet });
        return el("div", { className: "row" }, code, remove);
      }),
    );
    form.hidden = tipPrefs.buddyWallets.length >= MAX_BUDDY_WALLETS;
  };
  const input = el("input", { type: "text", placeholder: "Wallet address", spellcheck: false });
  input.setAttribute("aria-label", "Another wallet of yours");
  const add = el("button", { type: "submit", className: "button", textContent: "Add" });
  const problem = el("p", { className: "status warn" });
  problem.hidden = true;
  const form = el("form", { className: "lookup" }, input, add);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const wallet = input.value.trim();
    problem.hidden = true;
    if (!isMintAddress(wallet)) {
      problem.textContent = "That isn't a Solana wallet address.";
      problem.hidden = false;
      return;
    }
    if (tipPrefs.buddyWallets.includes(wallet)) {
      input.value = "";
      return;
    }
    tipPrefs = { ...tipPrefs, buddyWallets: [...tipPrefs.buddyWallets, wallet] };
    input.value = "";
    save();
    fill();
  });
  fill();
  return section(
    "Trade Buddy wallets",
    el("p", {
      className: "note",
      textContent: `Your account's wallet is always followed. Add up to ${MAX_BUDDY_WALLETS} more you trade from (Axiom's, Terminal's, a bot's), so those trades and their PnL show too. Their public addresses only: nothing here can trade.`,
    }),
    list,
    form,
    problem,
  );
}

/** Rings: the reader's own limits, dimming or hiding board coins past them (user ask 2026-10-27). */
function limitsSection(): HTMLElement {
  const save = () => void send({ type: "saveTooltip", prefs: tipPrefs });
  const mode = pick<LimitMode>(
    "Coins past a limit",
    tipPrefs.limits.mode,
    [
      ["off", "Leave them"],
      ["dim", "Dim them"],
      ["hide", "Hide them"],
    ],
    (m) => {
      tipPrefs = { ...tipPrefs, limits: { ...tipPrefs.limits, mode: m } };
      save();
    },
  );
  const rows = LIMIT_IDS.map((id) => {
    const meta = FLAG_LABELS[id];
    const current = tipPrefs.limits.values[id];
    const input = el("input", {
      type: "number",
      min: "0",
      step: "1",
      value: current === undefined ? "" : String(current),
      placeholder: "off",
    });
    input.setAttribute("aria-label", `${meta.label} limit`);
    input.addEventListener("change", () => {
      const values = { ...tipPrefs.limits.values };
      const n = Number(input.value);
      if (input.value.trim() === "" || !Number.isFinite(n) || n < 0) {
        delete values[id];
        input.value = "";
      } else values[id] = n;
      tipPrefs = { ...tipPrefs, limits: { ...tipPrefs.limits, values } };
      save();
    });
    return el(
      "label",
      { className: "opt" },
      el("div", {}, `${meta.label}${meta.unit === "%" ? " %" : ""} above`),
      input,
    );
  });
  return section(
    "Your limits on the boards",
    el("p", {
      className: "note",
      textContent:
        "A coin past any limit you fill in is dimmed or hidden on Axiom, Terminal and GMGN boards, alerts included. Uses TrenchScanner's newest numbers, so while on it sends the board's addresses to TrenchScanner.",
    }),
    mode,
    ...rows,
  );
}

/** Rings: each model's and filter's own colour and effect. */
function signalSection(): HTMLElement {
  const choices = signalChoices(feed?.tokens ?? [], tipPrefs.signals);
  const save = () => void send({ type: "saveTooltip", prefs: tipPrefs });
  const put = (key: SignalKey, name: string, change: Partial<SignalStyle>) => {
    const next: SignalStyle = { ...tipPrefs.signals[key], ...change, name };
    if (next.effect === "none") delete next.effect;
    const signals = { ...tipPrefs.signals };
    if (next.color || next.effect) signals[key] = next;
    else delete signals[key];
    tipPrefs = { ...tipPrefs, signals };
  };
  const rows = choices.map(({ key, name, kind }) => {
    const style = tipPrefs.signals[key] ?? {};
    const base = colorsOf(tipPrefs)[kind];
    const color = el("input", { type: "color", value: style.color ?? base });
    color.setAttribute("aria-label", `${name}'s ring colour`);
    color.addEventListener("change", () => {
      put(key, name, { color: color.value });
      save();
    });
    const effect = el(
      "select",
      {},
      ...RING_EFFECTS.map((fx) =>
        el("option", {
          value: fx,
          textContent: EFFECT_LABELS[fx],
          selected: fx === (style.effect ?? "none"),
        }),
      ),
    );
    effect.setAttribute("aria-label", `${name}'s ring effect`);
    effect.addEventListener("change", () => {
      put(key, name, { effect: effect.value as RingEffect });
      save();
    });
    const reset = el("button", { className: "link", textContent: "Reset" });
    reset.addEventListener("click", () => {
      const signals = { ...tipPrefs.signals };
      delete signals[key];
      tipPrefs = { ...tipPrefs, signals };
      color.value = base;
      effect.value = "none";
      save();
    });
    return el(
      "div",
      { className: "signal" },
      color,
      el("span", { className: "name", textContent: `${kind === "model" ? "Model" : "Filter"} · ${name}` }),
      // The store build draws no rings, so it has no ring effects.
      ...(__STORE__ ? [] : [effect]),
      reset,
    );
  });
  return section(
    "Each model and filter",
    el("p", {
      className: "note",
      textContent: rows.length
        ? __STORE__
          ? "Its own colour on its cards here, in place of the model or filter colour below. Models and filters show here once one is in your feed."
          : "Its own ring colour and an extra effect, on the boards and on its cards here, in place of the model or filter colour below. Models and filters show here once one is in your feed."
        : "Models and filters show here once one of them is in your feed.",
    }),
    ...rows,
  );
}

/** The panel's own accents follow the reader's colours: its cards wear the same rings and flags. */
function applyColors(): void {
  const colors = colorsOf(tipPrefs);
  const root = document.documentElement.style;
  root.setProperty("--model", colors.model);
  root.setProperty("--filter", colors.filter);
  root.setProperty("--risk", colors.risk);
  root.setProperty("--ok", colors.ok);
  root.setProperty("--mid", colors.mid);
  root.setProperty("--hi", colors.hi);
}

/** The colours the panel itself draws with (applyColors). */
const PANEL_COLOR_KEYS = [
  "model",
  "filter",
  "risk",
  "ok",
  "mid",
  "hi",
] as const satisfies readonly ColorKey[];

/** Rings: every colour the overlay draws with, each a colour picker. */
function colorSection(): HTMLElement {
  const save = () => {
    applyColors();
    void send({ type: "saveTooltip", prefs: tipPrefs });
  };
  // The store build draws only the panel, which uses the accents and none of the pills' or tooltip's.
  const keys = __STORE__ ? PANEL_COLOR_KEYS : COLOR_KEYS;
  const inputs = keys.map((key) => {
    const input = el("input", { type: "color", value: colorsOf(tipPrefs)[key] });
    input.setAttribute("aria-label", COLOR_LABELS[key]);
    // The panel follows the picker as it moves; the pages get the colour once it is picked.
    input.addEventListener("input", () => {
      tipPrefs = { ...tipPrefs, colors: { ...tipPrefs.colors, [key]: input.value } };
      applyColors();
    });
    input.addEventListener("change", save);
    return {
      key,
      input,
      row: el("label", { className: "colorline" }, input, el("span", { textContent: COLOR_LABELS[key] })),
    };
  });
  const reset = el("button", { className: "link", textContent: "Reset colours" });
  reset.addEventListener("click", () => {
    tipPrefs = { ...tipPrefs, colors: {} };
    for (const { key, input } of inputs) input.value = DEFAULT_COLORS[key];
    save();
  });
  return section(
    "Colours",
    el("p", {
      className: "note",
      textContent: __STORE__
        ? "The panel's accents: model alerts, filter matches, flags and the up and down numbers."
        : "For the rings, pills and tooltip on the boards, and the matching accents here.",
    }),
    el("div", { className: "colors" }, ...inputs.map((i) => i.row)),
    reset,
  );
}

function draw(): void {
  if (!status?.connected) {
    pruneMaps(new Set());
    renderDisconnected();
    return;
  }
  // Settings shows no map: none stays followed behind it.
  if (view === "settings") pruneMaps(new Set());
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
        : view === "coin"
          ? coinView(settings)
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
    // Settings edits redraw only when left, so an input in focus isn't replaced under the cursor;
    // the lookup redraws on its own reads.
    if (view !== "settings" && view !== "coin") draw();
  }
  pollTimer = window.setTimeout(() => void poll(), POLL_MS);
}

async function refresh(): Promise<void> {
  status = await send<Status>({ type: "status" });
  // Trade Buddy's last answer draws at once, and a fresh read starts now, so the tab is ready
  // before it is opened.
  if (status?.connected) {
    buddy ??= await send<BuddyRead>({ type: "buddy", cached: true });
    if (!buddy?.buddy) buddy = null;
    buddyReadAt = Date.now();
    void send<BuddyRead>({ type: "buddy" }).then((next) => {
      if (!next) return;
      buddy = next;
      if (view === "buddy") draw();
    });
  }
  tipPrefs = cleanTooltip(await send<TooltipPrefs>({ type: "tooltip" }));
  applyColors();
  // A page's Look up opened the panel: it opens on that coin.
  const pending = status?.connected ? await send<string | null>({ type: "pendingCoin" }) : null;
  if (pending && isMintAddress(pending)) {
    view = "coin";
    void lookUp(pending);
  }
  draw();
  if (status?.connected) await poll();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void poll();
});

// TrenchScanner's Settings handed over a key while the panel was open.
chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if (sender.id !== chrome.runtime.id) return;
  // The account's saved choices arrived (another browser, or a reinstall): drawn unless being edited.
  if ((message as { type?: unknown } | null)?.type === "lookChanged") {
    void send<TooltipPrefs>({ type: "tooltip" }).then((prefs) => {
      tipPrefs = cleanTooltip(prefs);
      applyColors();
      if (view !== "settings" && view !== "coin") draw();
    });
  }
  // A page's Look up while the panel is open.
  const m = message as { type?: unknown; mint?: unknown } | null;
  if (m?.type === "openCoin" && typeof m.mint === "string" && isMintAddress(m.mint) && status?.connected) {
    void send({ type: "pendingCoin" });
    view = "coin";
    void lookUp(m.mint);
  }
  if ((message as { type?: unknown } | null)?.type === "connected") {
    view = "alerts";
    feed = null;
    buddy = null;
    seen = null;
    pruneMaps(new Set());
    void refresh();
  }
});

void refresh();
