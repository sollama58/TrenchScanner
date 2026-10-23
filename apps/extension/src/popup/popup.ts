import { FLAG_IDS, FLAG_LABELS } from "../shared/settings";
import {
  RING_STYLES,
  SITES,
  type OverlaySettings,
  type PopupRequest,
  type Site,
  type Status,
} from "../shared/types";

/**
 * The toolbar popup: connect with a key from TrenchScanner Settings, then pick rings, flags,
 * sites and style. Changes save to the account through the service worker. Built with DOM calls
 * only; nothing here is parsed as HTML.
 */
const SITE_NAMES: Record<Site, string> = { axiom: "Axiom", terminal: "Terminal", gmgn: "GMGN" };
const STYLE_NAMES = { halo: "Halo", brackets: "Brackets", rail: "Edge rail" } as const;
const SETTINGS_URL = "https://trenchscanner.app/#settings";

const app = document.getElementById("app")!;
const account = document.getElementById("account")!;

function send<T>(request: PopupRequest): Promise<T> {
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

function renderDisconnected(error: string | null): void {
  account.textContent = "Not connected";
  account.className = "account";
  const input = el("input", { type: "text", placeholder: "tsx_…", autocomplete: "off", spellcheck: false });
  input.setAttribute("aria-label", "Extension key");
  const message = el("p", { className: "error", textContent: error ?? "" });
  const connect = el("button", { className: "primary", textContent: "Connect" });
  connect.addEventListener("click", async () => {
    connect.disabled = true;
    const result = await send<{ ok: boolean; error?: string }>({ type: "connect", key: input.value });
    if (result?.ok) void render();
    else {
      message.textContent = result?.error ?? "Couldn't connect.";
      connect.disabled = false;
    }
  });
  const link = el("a", {
    href: SETTINGS_URL,
    target: "_blank",
    rel: "noopener noreferrer",
    textContent: "TrenchScanner Settings",
  });
  app.replaceChildren(
    section(
      "Connect your account",
      el("p", {}, "Rings the tokens your filters and models alerted on Axiom, Terminal and GMGN."),
      el(
        "p",
        { className: "note" },
        "In ",
        link,
        ", open Browser extension, press Connect a browser, and paste the key here. It can only read your alerts and stats.",
      ),
      input,
      connect,
      message,
    ),
  );
}

function renderConnected(status: Status): void {
  const settings: OverlaySettings = structuredClone(status.settings);
  const save = () => void send({ type: "saveSettings", settings });

  account.textContent =
    status.problem === "refused" ? "Reconnect needed" : `Connected · ${status.wallet ?? ""}`;
  account.className = status.problem === "refused" ? "account warn" : "account on";

  const parts: HTMLElement[] = [];
  if (status.page) {
    const text = status.page.paused
      ? `Paused on ${SITE_NAMES[status.page.site]}: the page changed. An update is coming.`
      : `${SITE_NAMES[status.page.site]}: watching ${status.page.mints} tokens on screen.`;
    parts.push(
      el(
        "section",
        {},
        el("p", { className: `status${status.page.paused ? " paused" : ""}`, textContent: text }),
      ),
    );
  }
  if (status.problem === "refused") {
    parts.push(
      section(
        "Key refused",
        el("p", {
          className: "error",
          textContent: "The key was revoked or your subscription ended. Connect again with a new key.",
        }),
      ),
    );
  }

  parts.push(
    section(
      "Rings",
      toggle(
        "Model alerts",
        "Your followed models' calls",
        settings.rings.modelAlerts,
        "var(--model)",
        (on) => ((settings.rings.modelAlerts = on), save()),
      ),
      toggle(
        "Filter matches",
        "Your active filters",
        settings.rings.filterMatches,
        "var(--filter)",
        (on) => ((settings.rings.filterMatches = on), save()),
      ),
      toggle(
        "Only when the AI says buy",
        null,
        settings.rings.aiBuyOnly,
        "var(--model)",
        (on) => ((settings.rings.aiBuyOnly = on), save()),
      ),
      toggle(
        "Red ring past a flag's limit",
        null,
        settings.rings.riskRing,
        "var(--risk)",
        (on) => ((settings.rings.riskRing = on), save()),
      ),
    ),
  );

  const flags = FLAG_IDS.map((id) => {
    const pref = settings.flags[id];
    const meta = FLAG_LABELS[id];
    const box = el("input", { type: "checkbox", className: "switch", checked: pref.on });
    box.style.setProperty("--accent", "var(--risk)");
    box.setAttribute("aria-label", meta.label);
    box.addEventListener("change", () => ((pref.on = box.checked), save()));
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
  parts.push(section("Flags in the tooltip, with limits", ...flags));

  const sites = el(
    "div",
    { className: "sites" },
    ...SITES.map((site) => {
      const box = el("input", { type: "checkbox", checked: settings.sites[site] });
      box.addEventListener("change", () => ((settings.sites[site] = box.checked), save()));
      return el("label", {}, box, SITE_NAMES[site]);
    }),
  );
  parts.push(section("Sites", sites));

  const style = el(
    "select",
    {},
    ...RING_STYLES.map((s) =>
      el("option", { value: s, textContent: STYLE_NAMES[s], selected: settings.style.ring === s }),
    ),
  );
  style.setAttribute("aria-label", "Ring style");
  style.addEventListener(
    "change",
    () => ((settings.style.ring = style.value as OverlaySettings["style"]["ring"]), save()),
  );
  const disconnect = el("button", { className: "link", textContent: "Disconnect this browser" });
  disconnect.addEventListener("click", async () => {
    await send({ type: "disconnect" });
    void render();
  });
  parts.push(
    section(
      "Style",
      el("label", { className: "opt" }, el("span", { textContent: "Ring" }), style),
      toggle(
        "Calm motion",
        "The halo holds still",
        settings.style.calmMotion,
        "var(--filter)",
        (on) => ((settings.style.calmMotion = on), save()),
      ),
      disconnect,
    ),
  );
  app.replaceChildren(...parts);
}

async function render(): Promise<void> {
  const status = await send<Status>({ type: "status" });
  if (!status?.connected) renderDisconnected(null);
  else renderConnected(status);
}

void render();
