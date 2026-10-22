import { useCallback, useEffect, useState } from "react";
import {
  API_URL,
  api,
  del,
  post,
  type ModelAlertKey,
  type ModelAlertKeyCreated,
  type ModelAlertKeyList,
} from "../api";
import { useSettings } from "../alerts";
import { CopyIcon, LockIcon } from "./Icons";

/**
 * Settings, at the bottom: Model Alert API keys.
 *
 * A key is created only when Generate is pressed, and only for a paid subscription, an admin, or
 * a whitelist entry. The secret is shown once, from that response. Later the list is the prefix.
 * The socket is `key` on the query string and sends alerts that arrive after it connects.
 */
export function ModelAlertKeysPanel() {
  const settings = useSettings();
  const level = settings?.account.access.level ?? null;
  const blocked = level === "free_access" || level === "none";
  const [keys, setKeys] = useState<ModelAlertKey[] | null>(null);
  const [limit, setLimit] = useState(3);
  const [secret, setSecret] = useState<ModelAlertKeyCreated | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"load" | "generate" | string | null>("load");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const body = await api<ModelAlertKeyList>("/settings/model-alert-keys");
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
  const generate = () => {
    setBusy("generate");
    setError(null);
    setCopied(false);
    post<ModelAlertKeyCreated>("/settings/model-alert-keys")
      .then((created) => {
        setSecret(created);
        setKeys((current) => [
          ...(current ?? []),
          { id: created.id, prefix: created.prefix, createdAt: created.createdAt },
        ]);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };

  const revoke = (id: string) => {
    setBusy(id);
    setError(null);
    del<{ id: string }>(`/settings/model-alert-keys/${id}`)
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
      () => setError("Select the secret and copy it."),
    );
  };

  return (
    <section className="panel" id="model-alert-keys">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <LockIcon size={13} /> Model Alert API
          </span>
          <h2>API keys</h2>
        </div>
        <button
          type="button"
          className="primary"
          disabled={blocked || atCap || busy !== null || keys === null}
          onClick={generate}
        >
          Generate
        </button>
      </header>
      <p className="small muted">
        A paid subscription, an admin wallet, or a whitelist entry can open a websocket of Model Alerts. Free
        access cannot. A key is created only when you press Generate, up to {limit}. The secret is shown once.
        Connect with it as the <span className="num">key</span> query parameter. Alerts that arrive after you
        connect are sent; nothing from before you connect is replayed.
      </p>
      <p className="small">
        <code className="num">{socketUrl()}</code>
      </p>
      {blocked && (
        <p className="small">
          {level === "free_access"
            ? "Free access does not include Model Alert keys. Subscribe to generate one."
            : "Subscribe, or use an admin or whitelisted wallet, to generate a key."}
        </p>
      )}
      {secret && (
        <div>
          <p className="small">
            Copy this secret now. It is not shown again, and the list below keeps only the prefix.
          </p>
          <code className="mak-secret num">{secret.secret}</code>
          <p>
            <button type="button" className="small" onClick={copySecret}>
              <CopyIcon size={13} /> {copied ? "Copied" : "Copy secret"}
            </button>
          </p>
          <p className="small muted">
            <code className="num">{socketUrl(secret.secret)}</code>
          </p>
        </div>
      )}
      {keys === null ? (
        <p className="small muted">Loading keys…</p>
      ) : keys.length === 0 ? (
        <p className="small muted">No keys yet.</p>
      ) : (
        <div className="mak-list">
          {keys.map((key) => (
            <div className="mak-key" key={key.id}>
              <div>
                <code className="num">{key.prefix}</code>
                <div className="small muted">
                  {new Date(key.createdAt).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
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
      {atCap && keys !== null && <p className="small muted">Revoke a key to generate another.</p>}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

/** The socket URL. With a secret, the one-time connect string; otherwise a placeholder. */
function socketUrl(secret?: string): string {
  const base = API_URL.replace(/\/$/, "").replace(/^http/, "ws");
  return `${base}/v1/model-alerts?key=${secret ? encodeURIComponent(secret) : "YOUR_KEY"}`;
}
