import { useCallback, useEffect, useRef, useState } from "react";
import { api, del, post, type ExtensionKey, type ExtensionKeyCreated, type ExtensionKeyList } from "../api";
import { useSettings } from "../alerts";
import { findExtension, handOverKey, type InstalledExtension } from "../extensionBridge";
import { CopyIcon, GlobeIcon } from "./Icons";

/**
 * Settings, at the bottom: keys for the Trench Overlay browser extension, a side panel listing
 * the reader's alerts with links to Axiom, Terminal and GMGN. A key reads alerts, token stats and
 * the overlay's settings and nothing else. Paid access, the Model Alert rule (user decision
 * 2026-10-24).
 *
 * When this browser has the extension, "Connect this browser" makes a key and hands it straight to
 * the extension (extensionBridge.ts): the secret is never shown. "Show a key" is the fallback for
 * another browser, or when the hand-over fails. The extension's own "Connect with TrenchScanner"
 * opens this page with ?connect=extension, which scrolls here.
 */
export function ExtensionKeysPanel() {
  const settings = useSettings();
  const level = settings?.account.access.level ?? null;
  if (level !== "admin" && level !== "whitelist" && level !== "subscription") return null;
  return <ExtensionKeysBody />;
}

function ExtensionKeysBody() {
  const [keys, setKeys] = useState<ExtensionKey[] | null>(null);
  const [limit, setLimit] = useState(3);
  const [secret, setSecret] = useState<ExtensionKeyCreated | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>("load");
  const [copied, setCopied] = useState(false);
  const [installed, setInstalled] = useState<InstalledExtension | null>(null);
  const [handedOver, setHandedOver] = useState(false);
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    let live = true;
    void findExtension().then((found) => live && setInstalled(found));
    if (new URLSearchParams(window.location.search).get("connect") === "extension") {
      panel.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    return () => {
      live = false;
    };
  }, []);

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
  /** Makes a key; hands it to this browser's extension when there is one, else shows it once. */
  const connect = (handOver: boolean) => {
    setBusy("connect");
    setError(null);
    setCopied(false);
    setHandedOver(false);
    post<ExtensionKeyCreated>("/settings/extension-keys")
      .then(async (created) => {
        setKeys((current) => [
          ...(current ?? []),
          { id: created.id, prefix: created.prefix, createdAt: created.createdAt, lastUsedAt: null },
        ]);
        if (handOver && installed) {
          const result = await handOverKey(installed.id, created.secret);
          if (result.ok) {
            setHandedOver(true);
            setInstalled({ ...installed, connected: true });
            return;
          }
          setError(`${result.error ?? "The extension didn't take the key."} Paste the key below instead.`);
        }
        setSecret(created);
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
        setSecret((current) => (current?.id === id ? null : current));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };

  const copySecret = () => {
    if (!secret) return;
    void navigator.clipboard.writeText(secret.secret).then(
      () => setCopied(true),
      () => setError("Select the key and copy it."),
    );
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
        {installed && !installed.connected ? (
          <button
            type="button"
            className="primary"
            disabled={atCap || busy !== null || keys === null}
            onClick={() => connect(true)}
          >
            Connect this browser
          </button>
        ) : (
          <button
            type="button"
            className={installed ? "small" : "primary"}
            disabled={atCap || busy !== null || keys === null}
            onClick={() => connect(false)}
          >
            Show a key
          </button>
        )}
      </header>
      <p className="small muted">
        The extension lists the tokens your filters and models alert on in a side panel, with the stat flags
        you pick and links to open each on Axiom, Terminal or GMGN. It never runs on those sites. Each browser
        gets its own key, up to {limit}. A key can read your alerts, token stats and overlay settings. It
        cannot trade, see wallets, or change your filters. Revoke it here at any time.
      </p>
      {installed?.connected && (
        <p className="small">
          {handedOver
            ? "Connected. The panel in this browser is ready."
            : "This browser's extension is connected."}{" "}
          Use Show a key to connect another browser.
        </p>
      )}
      {secret && (
        <div>
          <p className="small">Paste this key into the extension. It is not shown again.</p>
          <code className="mak-secret num">{secret.secret}</code>
          <p>
            <button type="button" className="small" onClick={copySecret}>
              <CopyIcon size={13} /> {copied ? "Copied" : "Copy key"}
            </button>
          </p>
        </div>
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
