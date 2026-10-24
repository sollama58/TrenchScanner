import { FLAG_IDS, FLAG_LABELS } from "../shared/settings";
import {
  SITES,
  type FeedAnswer,
  type OverlaySettings,
  type PanelRequest,
  type Status,
} from "../shared/types";
import { verdictFor } from "../shared/verdict";
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

const app = document.getElementById("app")!;
const account = document.getElementById("account")!;

let view: "alerts" | "settings" = "alerts";
let status: Status | null = null;
let feed: FeedAnswer | null = null;
let pollTimer: number | undefined;
/** Mints already shown, so a new alert can be marked as new. */
let seen: Set<string> | null = null;
/** Cards whose "Why the AI said so" is open: the list redraws every poll and keeps them open. */
const openWhy = new Set<string>();

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
    });
    return button;
  };
  return el("nav", { className: "tabs" }, make("alerts", "Alerts"), make("settings", "Settings"));
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
    list.append(card);
  }
  seen = new Set(feed.tokens.map((t) => t.mint));
  parts.push(list);
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

  const disconnect = el("button", { className: "link", textContent: "Disconnect this browser" });
  disconnect.addEventListener("click", async () => {
    await send({ type: "disconnect" });
    feed = null;
    seen = null;
    void refresh();
  });
  parts.push(
    section(
      "Account",
      el("p", {
        className: "note",
        textContent:
          "This extension never runs on Axiom, Terminal or GMGN and can't see those pages or your logins. The key reads your alerts and stats only.",
      }),
      disconnect,
    ),
  );
  return parts;
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
  app.replaceChildren(tabs(), ...(view === "alerts" ? alertsView(settings) : settingsView(settings)));
}

async function poll(): Promise<void> {
  window.clearTimeout(pollTimer);
  if (document.visibilityState === "visible" && status?.connected) {
    // Status too: settings saved from another browser, or a key refused since the last poll.
    const [nextStatus, nextFeed] = await Promise.all([
      send<Status>({ type: "status" }),
      send<FeedAnswer>({ type: "feed" }),
    ]);
    status = nextStatus ?? status;
    feed = nextFeed ?? feed;
    // Settings edits redraw only when left, so an input in focus isn't replaced under the cursor.
    if (view === "alerts") draw();
  }
  pollTimer = window.setTimeout(() => void poll(), POLL_MS);
}

async function refresh(): Promise<void> {
  status = await send<Status>({ type: "status" });
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
    seen = null;
    void refresh();
  }
});

void refresh();
