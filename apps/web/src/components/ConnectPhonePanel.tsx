import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import qrcode from "qrcode-generator";
import { api, del, post } from "../api";
import { buildLinkUrl, describeDevice, type DeviceList, type IssuedLinkCode } from "../deviceLink";
import { ago } from "../format";
import { CheckIcon, CopyIcon, PhoneIcon, TrashIcon } from "./Icons";

/**
 * Settings card: sign a phone in by scanning a QR from this signed-in desktop, and see or switch
 * off the phones already signed in that way. See deviceLink.ts for the flow and why it is safe.
 *
 * On a phone that was itself paired, the card lists the phones and offers no QR: the API refuses
 * to let a paired phone pair another (a session minted that way would outlive the phone's own
 * revocation), so the button would only ever fail.
 */

/** How often the desktop asks whether the code on screen has been used, while one is up. */
const PAIRED_POLL_MS = 3_000;

type Code =
  | { state: "idle" }
  | { state: "minting" }
  | { state: "showing"; url: string; deadline: number }
  | { state: "expired" }
  | { state: "paired"; device: string };

export function ConnectPhonePanel() {
  const [list, setList] = useState<DeviceList | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [code, setCode] = useState<Code>({ state: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Device ids known before the code went up, so a new one means this code was just used.
  const before = useRef<Set<string> | null>(null);

  const load = useCallback(async (): Promise<DeviceList | null> => {
    try {
      const next = await api<DeviceList>("/auth/devices");
      setList(next);
      setListError(null);
      return next;
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onPhone = list?.currentDeviceId != null;

  const mint = async () => {
    setError(null);
    setCopied(false);
    setCode({ state: "minting" });
    try {
      const known = (await load())?.devices ?? list?.devices ?? [];
      before.current = new Set(known.map((d) => d.id));
      const issued = await post<IssuedLinkCode>("/auth/link/code");
      // The deadline from the TTL, on this clock: a skewed desktop clock would misread the API's
      // absolute expiresAt, and a few minutes of skew is a lot against a two-minute window.
      const ttl = Number.isFinite(issued.ttlMs) && issued.ttlMs > 0 ? issued.ttlMs : 120_000;
      setCode({
        state: "showing",
        url: buildLinkUrl(window.location.origin, issued.code),
        deadline: Date.now() + ttl,
      });
    } catch (e) {
      setCode({ state: "idle" });
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // While a code is up: count it down, and notice when a phone has used it.
  const showing = code.state === "showing" ? code : null;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!showing) return;
    const tick = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      // Gone from the screen and from memory once it can no longer work: a copy button that
      // hands out a dead link is worse than none.
      if (t >= showing.deadline) setCode({ state: "expired" });
    }, 1_000);
    const watch = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void load().then((next) => {
        const fresh = next?.devices.find((d) => !before.current?.has(d.id));
        if (fresh) setCode({ state: "paired", device: describeDevice(fresh.userAgent) });
      });
    }, PAIRED_POLL_MS);
    setNow(Date.now());
    return () => {
      window.clearInterval(tick);
      window.clearInterval(watch);
    };
  }, [showing, load]);

  const copy = async () => {
    if (!showing) return;
    try {
      await navigator.clipboard.writeText(showing.url);
      setCopied(true);
    } catch {
      setError("Couldn't copy: this browser blocked the clipboard.");
    }
  };

  const revoke = async (id: string | null) => {
    if (id === null && !window.confirm("Sign out every phone linked to this account?")) return;
    setBusy(id ?? "all");
    setError(null);
    try {
      await (id === null ? del("/auth/devices") : del(`/auth/devices/${encodeURIComponent(id)}`));
      if (onPhone && (id === null || id === list?.currentDeviceId)) {
        // This phone just signed itself out: its session is gone, so start again from sign-in.
        window.location.reload();
        return;
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const secsLeft = showing ? Math.max(0, Math.ceil((showing.deadline - now) / 1000)) : 0;
  const devices = list?.devices ?? [];

  return (
    <section className="panel connect-phone">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <PhoneIcon size={13} /> Phone
          </span>
          <h2>{onPhone ? "Linked phones" : "Connect your phone"}</h2>
        </div>
      </header>

      {onPhone ? (
        <p className="muted small">
          This phone is signed in through your desktop. To link another phone, open Settings on a desktop
          where your wallet is signed in.
        </p>
      ) : (
        <div className="cp-pair">
          <div className="cp-qr-wrap">
            {showing ? (
              <QrCode value={showing.url} />
            ) : (
              <div className="cp-qr-placeholder" aria-hidden>
                {code.state === "paired" ? <CheckIcon size={40} /> : <PhoneIcon size={40} />}
              </div>
            )}
          </div>
          <div className="cp-steps">
            {code.state === "paired" ? (
              <>
                <p className="cp-status good" role="status">
                  <CheckIcon size={15} /> Signed in on {code.device}.
                </p>
                <p className="muted small">It stays signed in until you sign it out below.</p>
              </>
            ) : (
              <ol className="muted small">
                <li>Press the button to show a QR code.</li>
                <li>Scan it with your phone&apos;s camera and open the link.</li>
                <li>Your phone signs in to this account. No wallet needed on the phone.</li>
              </ol>
            )}
            {showing && (
              <p className={`cp-status num${secsLeft <= 20 ? " urgent" : ""}`} role="timer" aria-live="off">
                Expires in {Math.floor(secsLeft / 60)}:{String(secsLeft % 60).padStart(2, "0")} · works once
              </p>
            )}
            {code.state === "expired" && <p className="cp-status">That code expired. Make a new one.</p>}
            <div className="cp-actions">
              <button className="button primary" onClick={mint} disabled={code.state === "minting"}>
                {code.state === "minting"
                  ? "Making a code…"
                  : showing || code.state === "expired" || code.state === "paired"
                    ? "New code"
                    : "Show QR code"}
              </button>
              {showing && (
                <button className="button ghost" onClick={copy} title="Copy the sign-in link">
                  {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
                  {copied ? "Copied" : "Copy link"}
                </button>
              )}
            </div>
            <p className="faint small">
              Only show the code to your own phone: whoever scans it first is signed in as you.
            </p>
          </div>
        </div>
      )}

      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}

      <div className="cp-devices">
        <h3>Phones signed in{devices.length > 0 ? ` (${devices.length})` : ""}</h3>
        {listError && !list ? (
          <p className="error small">Couldn&apos;t load your phones: {listError}</p>
        ) : !list ? (
          <p className="muted small">Loading…</p>
        ) : devices.length === 0 ? (
          <p className="muted small">None yet.</p>
        ) : (
          <ul className="cp-device-list">
            {devices.map((d) => {
              const self = d.id === list.currentDeviceId;
              return (
                <li key={d.id} className="cp-device">
                  <PhoneIcon size={16} />
                  <div className="cp-device-body">
                    <span className="cp-device-name">
                      {describeDevice(d.userAgent)}
                      {self && <span className="badge info">this phone</span>}
                    </span>
                    <span className="faint small">
                      Linked {ago(d.createdAt)}
                      {d.lastSeenAt ? ` · last used ${ago(d.lastSeenAt)}` : ""}
                    </span>
                  </div>
                  <button
                    className="button ghost danger"
                    onClick={() => void revoke(d.id)}
                    disabled={busy !== null}
                    title={self ? "Sign this phone out" : "Sign this phone out of your account"}
                  >
                    <TrashIcon size={14} />
                    {busy === d.id ? "Signing out…" : "Sign out"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {devices.length > 1 && (
          <button className="button ghost danger" onClick={() => void revoke(null)} disabled={busy !== null}>
            {busy === "all" ? "Signing out…" : "Sign out every phone"}
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * The QR, drawn as one SVG path from the encoder's module grid rather than injected markup.
 * Always dark on white, whatever the theme: phone cameras read light-on-dark codes badly.
 */
function QrCode({ value }: { value: string }) {
  const { size, path } = useMemo(() => {
    // Level M: survives a camera at an angle without so many modules it needs a big screen.
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x} ${y}h1v1h-1z`;
    }
    return { size: n, path: d };
  }, [value]);
  const quiet = 4;
  return (
    <svg
      className="cp-qr"
      viewBox={`${-quiet} ${-quiet} ${size + quiet * 2} ${size + quiet * 2}`}
      role="img"
      aria-label="QR code to sign your phone in"
      shapeRendering="crispEdges"
    >
      <rect x={-quiet} y={-quiet} width={size + quiet * 2} height={size + quiet * 2} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
