import { useCallback, useEffect, useRef, useState } from "react";
import { api, del, post, type ExtensionKey, type ExtensionKeyCreated, type ExtensionKeyList } from "../api";
import { useSettings } from "../alerts";
import { findExtension, handOverKey, type InstalledExtension } from "../extensionBridge";
import { GlobeIcon } from "./Icons";

/**
 * Settings, at the bottom: the Trench Overlay browser extension, a side panel listing the reader's
 * alerts with links to Axiom, Terminal and GMGN. Paid access, the Model Alert rule (user decision
 * 2026-10-24).
 *
 * Connecting is one click and the key is never shown (user ask 2026-10-24): the panel's "Connect
 * with TrenchScanner" opens this page as ?connect=extension&ext=<its ID>#settings, the page scrolls
 * here, finds the extension (extensionBridge.ts) and "Connect this browser" makes a key and hands it
 * over. The list below revokes keys, including those of other browsers.
 */
export function ExtensionKeysPanel() {
  const settings = useSettings();
  const level = settings?.account.access.level ?? null;
  if (level !== "admin" && level !== "whitelist" && level !== "subscription") return null;
  return <ExtensionKeysBody />;
}

/** What the extension's link asked for: to connect, and its own ID when it sent one. */
function connectRequest(): { asked: boolean; ext: string | null } {
  const params = new URLSearchParams(window.location.search);
  return { asked: params.get("connect") === "extension", ext: params.get("ext") };
}

/**
 * Keeps the panel in view while the Settings cards above it finish loading and push it down, until
 * the reader scrolls or touches the page themselves, or a few seconds pass.
 */
function useScrollIntoViewWhileLoading(target: { current: HTMLElement | null }, active: boolean) {
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const place = () => {
      if (!stopped) target.current?.scrollIntoView({ block: "center", behavior: "auto" });
    };
    const stop = () => {
      stopped = true;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(document.body);
    const events = ["wheel", "touchstart", "keydown", "mousedown"] as const;
    for (const e of events) window.addEventListener(e, stop, { passive: true, once: true });
    const timer = window.setTimeout(stop, 4000);
    return () => {
      stop();
      observer.disconnect();
      window.clearTimeout(timer);
      for (const e of events) window.removeEventListener(e, stop);
    };
  }, [target, active]);
}

function ExtensionKeysBody() {
  const [request] = useState(connectRequest);
  const [keys, setKeys] = useState<ExtensionKey[] | null>(null);
  const [limit, setLimit] = useState(3);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>("load");
  // undefined while looking, null when this browser has no Trench Overlay.
  const [installed, setInstalled] = useState<InstalledExtension | null | undefined>(undefined);
  const [handedOver, setHandedOver] = useState(false);
  const panel = useRef<HTMLElement>(null);
  useScrollIntoViewWhileLoading(panel, request.asked);

  useEffect(() => {
    let live = true;
    void findExtension(request.ext).then((found) => live && setInstalled(found));
    if (request.asked) {
      // A reload or a shared URL shouldn't scroll here again.
      const url = new URL(window.location.href);
      url.searchParams.delete("connect");
      url.searchParams.delete("ext");
      window.history.replaceState(window.history.state, "", url.toString());
    }
    return () => {
      live = false;
    };
  }, [request]);

  const load = useCallback(async () => {
    try {
      const body = await api<ExtensionKeyList>("/settings/extension-keys");
      setKeys(body.keys);
      setLimit(body.limit);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy((current) => (current === "load" ? null : current));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const atCap = (keys?.length ?? 0) >= limit;
  /** Makes a key and hands it straight to this browser's extension. */
  const connect = () => {
    if (!installed) return;
    setBusy("connect");
    setError(null);
    setHandedOver(false);
    post<ExtensionKeyCreated>("/settings/extension-keys")
      .then(async (created) => {
        setKeys((current) => [
          ...(current ?? []),
          { id: created.id, prefix: created.prefix, createdAt: created.createdAt, lastUsedAt: null },
        ]);
        const result = await handOverKey(installed.id, created.secret, request.ext);
        if (result.ok) {
          setHandedOver(true);
          setInstalled({ ...installed, connected: true });
          return;
        }
        // The key it couldn't take is no use to anyone: revoke it.
        await del(`/settings/extension-keys/${created.id}`).catch(() => undefined);
        setKeys((current) => current?.filter((key) => key.id !== created.id) ?? null);
        setError(result.error ?? "The extension didn't take the key. Try again.");
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };

  const revoke = (id: string) => {
    setBusy(id);
    setError(null);
    del<{ id: string }>(`/settings/extension-keys/${id}`)
      .then(() => {
        setKeys((current) => current?.filter((key) => key.id !== id) ?? null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };

  const day = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

  return (
    <section className="panel" id="extension-keys" ref={panel}>
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <GlobeIcon size={13} /> Trench Overlay
          </span>
          <h2>Browser extension</h2>
        </div>
        {installed && !installed.connected && (
          <button
            type="button"
            className="primary"
            disabled={atCap || busy !== null || keys === null}
            onClick={connect}
          >
            Connect this browser
          </button>
        )}
      </header>
      <p className="small muted">
        The extension lists the tokens your filters and models alert on in a side panel, with the stat flags
        you pick and links to open each on Axiom, Terminal or GMGN. It never runs on those sites. Each browser
        gets its own key, up to {limit}. A key can read your alerts, token stats and overlay settings. It
        cannot trade, see wallets, or change your filters. Revoke it here at any time.
      </p>
      {installed === undefined ? (
        <p className="small muted">Looking for the extension in this browser…</p>
      ) : installed === null ? (
        <p className="small">
          To connect a browser, install Trench Overlay in it, open its panel and press Connect with
          TrenchScanner. This page then connects it in one click.
        </p>
      ) : installed.connected ? (
        <p className="small">
          {handedOver
            ? "Connected. The panel in this browser is ready."
            : "This browser's extension is connected."}
        </p>
      ) : (
        <p className="small">
          Trench Overlay is installed in this browser. Connect it with the button above.
        </p>
      )}
      {keys === null ? (
        <p className="small muted">Loading browsers…</p>
      ) : keys.length === 0 ? (
        <p className="small muted">No browsers connected.</p>
      ) : (
        <div className="mak-list">
          {keys.map((key) => (
            <div className="mak-key" key={key.id}>
              <div>
                <code className="num">{key.prefix}</code>
                <div className="small muted">
                  Connected {day(key.createdAt)}
                  {key.lastUsedAt ? ` · last used ${day(key.lastUsedAt)}` : " · not used yet"}
                </div>
              </div>
              <button
                type="button"
                className="ghost small danger"
                disabled={busy !== null}
                onClick={() => revoke(key.id)}
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
      {atCap && keys !== null && <p className="small muted">Revoke a browser to connect another.</p>}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}
