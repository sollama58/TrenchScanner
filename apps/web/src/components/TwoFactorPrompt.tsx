import { useEffect, useRef, useState } from "react";
import { usePromptRequest, type PromptRequest, type SecondFactor } from "../twoFactor";
import { CloseIcon, LockIcon } from "./Icons";

/** The two-factor prompt, on every screen; twoFactor.ts opens it. */
export function TwoFactorPromptHost() {
  const req = usePromptRequest();
  // Keyed by the request itself: a new ask starts fresh, a re-render of App keeps what was typed.
  return req ? <TwoFactorPrompt key={req.id} req={req} /> : null;
}

function TwoFactorPrompt({ req }: { req: PromptRequest }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<"code" | "backup">(req.hint.totp ? "code" : "backup");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  const tryFactor = async (factor: SecondFactor) => {
    setBusy(true);
    setError(null);
    try {
      await req.submit(factor);
      req.done(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const usePasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const { options, token } = await req.passkeyOptions();
      const response = await startAuthentication({ optionsJSON: options as never });
      await tryFactor({ passkey: { token, response } });
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      setError(
        name === "NotAllowedError"
          ? "The passkey check was cancelled or timed out."
          : e instanceof Error
            ? e.message
            : String(e),
      );
      setBusy(false);
    }
  };

  const submitTyped = (e: React.FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!v) return;
    void tryFactor(mode === "code" ? { code: v.replace(/\s/g, "") } : { backupCode: v });
  };

  return (
    <dialog
      ref={ref}
      className="about-modal sheet-modal tf-modal"
      aria-labelledby="tf-title"
      onClose={() => req.done(false)}
    >
      <div className="about-body">
        <header className="about-head">
          <h2 id="tf-title">
            <LockIcon size={16} /> {req.title}
          </h2>
          <button className="ghost icon-btn" onClick={() => req.done(false)} aria-label="Cancel">
            <CloseIcon size={16} />
          </button>
        </header>
        {req.hint.passkey && (
          <button className="button primary tf-passkey" disabled={busy} onClick={() => void usePasskey()}>
            Use a passkey
          </button>
        )}
        <form className="tf-form" onSubmit={submitTyped}>
          <label className="small muted" htmlFor="tf-input">
            {mode === "code" ? "The 6-digit code from your authenticator app" : "One of your backup codes"}
          </label>
          <input
            id="tf-input"
            className="num"
            autoFocus={!req.hint.passkey}
            autoComplete="one-time-code"
            inputMode={mode === "code" ? "numeric" : "text"}
            maxLength={mode === "code" ? 8 : 20}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={busy}
          />
          <button className="button" type="submit" disabled={busy || !value.trim()}>
            {busy ? "Checking…" : "Confirm"}
          </button>
        </form>
        {req.hint.totp && (
          <button
            className="link small"
            type="button"
            onClick={() => {
              setMode(mode === "code" ? "backup" : "code");
              setValue("");
              setError(null);
            }}
          >
            {mode === "code" ? "Use a backup code instead" : "Use the authenticator app instead"}
          </button>
        )}
        {error && (
          <p className="error small" role="alert">
            {error}
          </p>
        )}
      </div>
    </dialog>
  );
}
