import { useCallback, useEffect, useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import { api } from "../api";
import { ACTION_CHOICES, TwoFactorCancelled, withTwoFactor } from "../twoFactor";
import { ago } from "../format";
import { CheckIcon, CopyIcon, LockIcon, TrashIcon } from "./Icons";

/**
 * Settings card: two-factor (user decision 2026-10-18). Optional; an authenticator app, passkeys,
 * or both, and the actions that ask for it. Once it's on, every change here asks for it first
 * (the API answers 403 and withTwoFactor prompts).
 */

interface State {
  enabled: boolean;
  totp: boolean;
  passkeys: { id: string; name: string; createdAt: string; lastUsedAt: string | null }[];
  actions: string[];
  buyOverLamports: string | null;
  backupCodesLeft: number;
}

type Setup =
  { step: "idle" } | { step: "scan"; secret: string; url: string } | { step: "codes"; codes: string[] };

/** A JSON call that asks for two-factor when the API says so. */
function call<T>(path: string, method: string, body?: unknown): Promise<T> {
  return withTwoFactor((headers) =>
    api<T>(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
  );
}

export function TwoFactorPanel({ onChanged }: { onChanged?: () => void }) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [setup, setSetup] = useState<Setup>({ step: "idle" });
  const [code, setCode] = useState("");
  const [actions, setActions] = useState<Set<string>>(new Set());
  const [buyOver, setBuyOver] = useState("");

  const load = useCallback(async () => {
    try {
      const s = await api<State>("/auth/2fa");
      setState(s);
      setActions(new Set(s.actions));
      setBuyOver(s.buyOverLamports ? String(Number(s.buyOverLamports) / 1e9) : "");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
      onChanged?.();
    } catch (e) {
      if (!(e instanceof TwoFactorCancelled)) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const startTotp = () =>
    run("totp", async () => {
      const s = await call<{ secret: string; otpauthUrl: string }>("/auth/2fa/totp/setup", "POST");
      setSetup({ step: "scan", secret: s.secret, url: s.otpauthUrl });
      setCode("");
    });

  const confirmTotp = () =>
    run("confirm", async () => {
      const r = await call<{ backupCodes: string[] | null }>("/auth/2fa/totp/confirm", "POST", {
        code: code.replace(/\s/g, ""),
      });
      setSetup(r.backupCodes ? { step: "codes", codes: r.backupCodes } : { step: "idle" });
    });

  const addPasskey = () =>
    run("passkey", async () => {
      const { startRegistration } = await import("@simplewebauthn/browser");
      const { options, token } = await call<{ options: unknown; token: string }>(
        "/auth/2fa/passkey/register-options",
        "POST",
      );
      let response: unknown;
      try {
        response = await startRegistration({ optionsJSON: options as never });
      } catch (e) {
        if ((e as { name?: string } | null)?.name === "NotAllowedError")
          throw new Error("The passkey wasn't added: it was cancelled or timed out.", { cause: e });
        throw e;
      }
      const name = navigator.userAgent.includes("Mac") ? "Mac or iPhone" : "This device";
      const r = await call<{ backupCodes: string[] | null }>("/auth/2fa/passkey/register", "POST", {
        token,
        response,
        name,
      });
      if (r.backupCodes) setSetup({ step: "codes", codes: r.backupCodes });
    });

  const saveActions = () =>
    run("actions", async () => {
      const sol = buyOver.trim() ? Number(buyOver) : null;
      if (actions.has("buyOver") && (sol === null || !(sol >= 0.01 && sol <= 1000)))
        throw new Error("Set a buy size between 0.01 and 1000 SOL.");
      await call("/auth/2fa/actions", "PUT", {
        actions: [...actions].filter((a) => a !== "export"),
        buyOverSol: actions.has("buyOver") ? sol : null,
      });
    });

  const newCodes = () =>
    run("codes", async () => {
      const r = await call<{ backupCodes: string[] }>("/auth/2fa/backup-codes", "POST");
      setSetup({ step: "codes", codes: r.backupCodes });
    });

  const changed = useMemo(() => {
    if (!state) return false;
    const was = new Set(state.actions);
    const same = was.size === actions.size && [...was].every((a) => actions.has(a));
    const wasOver = state.buyOverLamports ? String(Number(state.buyOverLamports) / 1e9) : "";
    return !same || (actions.has("buyOver") && buyOver !== wasOver);
  }, [state, actions, buyOver]);

  return (
    <section className="panel two-factor">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <LockIcon size={13} /> Security
          </span>
          <h2>Two-factor</h2>
        </div>
        {state && (
          <span className={`badge ${state.enabled ? "good" : ""}`}>{state.enabled ? "On" : "Off"}</span>
        )}
      </header>
      <p className="muted small">
        Optional. Add an authenticator app or a passkey, then choose which actions ask for it. Exporting a
        wallet key and changing these settings always ask once it&apos;s on.
      </p>
      {!state ? (
        error ? (
          <button
            className="small"
            onClick={() => {
              setError(null);
              void load();
            }}
          >
            Try again
          </button>
        ) : (
          <p className="muted small">Loading…</p>
        )
      ) : (
        <>
          {setup.step === "scan" && <TotpSetup secret={setup.secret} url={setup.url} />}
          {setup.step === "scan" && (
            <form
              className="tf-form"
              onSubmit={(e) => {
                e.preventDefault();
                void confirmTotp();
              }}
            >
              <label className="small muted" htmlFor="tf-setup-code">
                Then type the 6-digit code it shows
              </label>
              <input
                id="tf-setup-code"
                className="num"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={8}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <button className="button primary" type="submit" disabled={busy !== null || !code.trim()}>
                {busy === "confirm" ? "Checking…" : "Turn on"}
              </button>
              <button type="button" className="button ghost" onClick={() => setSetup({ step: "idle" })}>
                Cancel
              </button>
            </form>
          )}
          {setup.step === "codes" && (
            <BackupCodes codes={setup.codes} onDone={() => setSetup({ step: "idle" })} />
          )}

          <div className="tf-factors">
            <div className="tf-factor">
              <strong>Authenticator app</strong>
              {state.totp ? (
                <button
                  className="button ghost small"
                  disabled={busy !== null}
                  onClick={() => void run("totp-off", () => call("/auth/2fa/totp", "DELETE"))}
                >
                  Remove
                </button>
              ) : (
                setup.step !== "scan" && (
                  <button className="button small" disabled={busy !== null} onClick={() => void startTotp()}>
                    Set up
                  </button>
                )
              )}
            </div>
            <div className="tf-factor">
              <strong>Passkeys</strong>
              <button className="button small" disabled={busy !== null} onClick={() => void addPasskey()}>
                {busy === "passkey" ? "Waiting…" : "Add a passkey"}
              </button>
            </div>
            {state.passkeys.map((p) => (
              <div key={p.id} className="tf-passkey-row small">
                <span>{p.name || "Passkey"}</span>
                <span className="faint">
                  added {ago(p.createdAt)}
                  {p.lastUsedAt ? `, used ${ago(p.lastUsedAt)}` : ""}
                </span>
                <button
                  className="ghost icon-btn"
                  aria-label={`Remove ${p.name || "passkey"}`}
                  disabled={busy !== null}
                  onClick={() =>
                    void run("pk-" + p.id, () =>
                      call(`/auth/2fa/passkey/${encodeURIComponent(p.id)}`, "DELETE"),
                    )
                  }
                >
                  <TrashIcon size={14} />
                </button>
              </div>
            ))}
          </div>

          {state.enabled && (
            <>
              <fieldset className="tf-actions">
                <legend className="small muted">Ask for two-factor when</legend>
                {ACTION_CHOICES.map((c) => (
                  <label key={c.id} className="tf-action small">
                    <input
                      type="checkbox"
                      checked={c.id === "export" || actions.has(c.id)}
                      disabled={c.id === "export" || busy !== null}
                      onChange={(e) => {
                        const next = new Set(actions);
                        if (e.target.checked) next.add(c.id);
                        else next.delete(c.id);
                        setActions(next);
                      }}
                    />
                    <span>{c.label}</span>
                    {c.id === "buyOver" && actions.has("buyOver") && (
                      <span className="tf-buyover">
                        <input
                          type="number"
                          inputMode="decimal"
                          min={0.01}
                          max={1000}
                          step={0.01}
                          value={buyOver}
                          aria-label="Buy size in SOL that asks for two-factor"
                          onChange={(e) => setBuyOver(e.target.value)}
                        />{" "}
                        SOL or more
                      </span>
                    )}
                  </label>
                ))}
              </fieldset>
              {changed && (
                <button
                  className="button primary"
                  disabled={busy !== null}
                  onClick={() => void saveActions()}
                >
                  {busy === "actions" ? "Saving…" : "Save choices"}
                </button>
              )}
              <p className="faint small">
                Backup codes left: {state.backupCodesLeft}.{" "}
                <button className="link" disabled={busy !== null} onClick={() => void newCodes()}>
                  Make new ones
                </button>{" "}
                (the old ones stop working).
              </p>
            </>
          )}
        </>
      )}
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function TotpSetup({ secret, url }: { secret: string; url: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [url]);
  const [copied, setCopied] = useState(false);
  return (
    <div className="tf-setup">
      <p className="small">
        Scan this with your authenticator app (Google Authenticator, 1Password, Authy…).
      </p>
      <div
        className="tf-qr"
        aria-label="QR code for your authenticator app"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {/* On a phone the app is usually on this same phone, where a QR code can't be scanned. */}
      <a className="button tf-open-app" href={url}>
        Open in authenticator app
      </a>
      <p className="small muted">
        Or type this key: <code className="num tf-secret">{secret.replace(/(.{4})/g, "$1 ").trim()}</code>{" "}
        <button
          className="ghost icon-btn"
          aria-label="Copy the key"
          onClick={() => {
            void navigator.clipboard?.writeText(secret).then(
              () => setCopied(true),
              () => {},
            );
          }}
        >
          {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
        </button>
      </p>
    </div>
  );
}

function BackupCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="tf-codes notice">
      <p className="small">
        <strong>Save these backup codes.</strong> Each one works once, if you lose your phone or passkey. They
        aren&apos;t shown again.
      </p>
      <ul className="tf-code-list num">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <button
        className="button small"
        onClick={() => void navigator.clipboard?.writeText(codes.join("\n")).then(() => setCopied(true))}
      >
        {copied ? "Copied" : "Copy all"}
      </button>{" "}
      <button className="button primary small" onClick={onDone}>
        I saved them
      </button>
    </div>
  );
}
