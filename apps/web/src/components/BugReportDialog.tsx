import { useEffect, useRef, useState } from "react";
import { post } from "../api";
import { APP_VERSION } from "../version";
import { shortAddress } from "../format";
import { isLinkHash } from "../deviceLink";
import { BugIcon, CheckIcon, CloseIcon, StarIcon, TrashIcon } from "./Icons";

/** Mirrors apps/api/src/routes/feedback.ts. */
const MESSAGE_MAX = 2000;
const CONTACT_MAX = 200;
/** Under the API's 500,000-character cap (FEEDBACK_SCREENSHOT_MAX), with room to spare. */
const SCREENSHOT_TARGET = 450_000;

/** Where the reader is when they open the form; sent along so admins don't have to ask. */
export interface ReportWhere {
  tab: string;
  signedIn: boolean;
  guest: boolean;
  walletAddress: string | null;
}

type Kind = "bug" | "idea";

/**
 * What they had typed, kept across closing and reopening the form (a stray tap on the backdrop
 * closes it) until it is sent. In memory only: a reload starts over.
 */
const draft: { kind: Kind; message: string; contact: string; screenshot: string | null } = {
  kind: "bug",
  message: "",
  contact: "",
  screenshot: null,
};

/** Forgets the unsent draft, so the next person on this browser doesn't see it (on sign-out). */
export function clearBugReportDraft() {
  Object.assign(draft, { kind: "bug", message: "", contact: "", screenshot: null });
}

/** A JPEG data URL of the image, scaled down until it fits under the API's cap. */
function shrink(source: CanvasImageSource, width: number, height: number): string | null {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx || !width || !height) return null;
  for (const [edge, quality] of [
    [1600, 0.82],
    [1280, 0.72],
    [1024, 0.62],
    [800, 0.55],
  ] as const) {
    const scale = Math.min(1, edge / Math.max(width, height));
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/jpeg", quality);
    if (url.length <= SCREENSHOT_TARGET) return url;
  }
  return null;
}

/** One frame of the reader's screen, through the browser's own screen-share picker. */
async function captureScreen(): Promise<string | null> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: "browser" },
    audio: false,
    // Chrome offers this tab first; other browsers ignore it.
    preferCurrentTab: true,
  } as DisplayMediaStreamOptions);
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    // Give the page a moment to repaint without the form over it.
    await new Promise((r) => setTimeout(r, 450));
    return shrink(video, video.videoWidth, video.videoHeight);
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}

/** Phones and tablets have no screen share in the browser, so they get no screenshot option. */
const canCapture =
  typeof navigator !== "undefined" &&
  typeof navigator.mediaDevices?.getDisplayMedia === "function" &&
  !window.matchMedia?.("(pointer: coarse)").matches;

/** The page's address, less a phone-pairing code should one still be in the hash. */
function pageUrl(): string {
  const { origin, pathname, search, hash } = window.location;
  return (origin + pathname + search + (isLinkHash(hash) ? "" : hash)).slice(0, 500);
}

function theme(): string {
  const set = document.documentElement.dataset.theme;
  if (set) return set;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "auto (light)" : "auto (dark)";
}

function context(where: ReportWhere) {
  return {
    url: pageUrl(),
    tab: where.tab,
    appVersion: APP_VERSION || "dev",
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    screen: `${window.screen.width}x${window.screen.height}`,
    dpr: Math.round(window.devicePixelRatio * 100) / 100,
    userAgent: navigator.userAgent.slice(0, 400),
    theme: theme(),
    language: navigator.language.slice(0, 20),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone?.slice(0, 60),
    signedIn: where.signedIn,
    guest: where.guest,
  };
}

/** The bug report / suggestion form the bug button opens. */
export function BugReportDialog({ onClose, ...where }: ReportWhere & { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState<Kind>(draft.kind);
  const [message, setMessage] = useState(draft.message);
  const [contact, setContact] = useState(draft.contact);
  const [screenshot, setScreenshot] = useState<string | null>(draft.screenshot);
  const [honeypot, setHoneypot] = useState("");
  const [busy, setBusy] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageNote, setImageNote] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    Object.assign(draft, { kind, message, contact, screenshot });
  }, [kind, message, contact, screenshot]);

  const capture = async () => {
    if (capturing) return;
    setImageNote(null);
    // Hidden, not closed, so the frame shows the page and the form keeps what was typed.
    setCapturing(true);
    try {
      const url = await captureScreen();
      setScreenshot(url);
      if (!url) setImageNote("Couldn't make that screenshot small enough to send.");
    } catch (e) {
      // Pressing Cancel in the browser's picker is not an error worth showing.
      if ((e as Error).name !== "NotAllowedError" && (e as Error).name !== "AbortError")
        setImageNote("Couldn't capture the screen in this browser.");
    } finally {
      setCapturing(false);
    }
  };

  const trimmed = message.trim();
  const send = async () => {
    if (busy) return;
    if (trimmed.length < 5) {
      setError("Say a little more about it.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await post("/feedback", {
        kind,
        message: trimmed,
        contact: contact.trim() || undefined,
        context: context(where),
        screenshot: screenshot ?? undefined,
        website: honeypot || undefined,
      });
      clearBugReportDraft();
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={ref}
      className={`about-modal sheet-modal bug-modal${capturing ? " capturing" : ""}`}
      aria-labelledby="bug-report-title"
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself; clicks inside land on its content.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="about-body">
        <header className="about-head">
          <h2 id="bug-report-title" className="bug-title">
            <BugIcon size={18} /> {sent ? "Thanks!" : "Report a bug or idea"}
          </h2>
          <button className="ghost icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </header>

        {sent ? (
          <div className="bug-sent">
            <span className="bug-sent-mark">
              <CheckIcon size={22} />
            </span>
            <p>
              {kind === "bug"
                ? "Your report is with the team, along with where you were in the app."
                : "Your suggestion is with the team."}{" "}
              {contact.trim() ? "We'll reach out if we need more." : ""}
            </p>
            <button className="button primary" onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <form
            className="bug-form"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <div className="segmented bug-kind" role="radiogroup" aria-label="What is it?">
              <button
                type="button"
                role="radio"
                aria-checked={kind === "bug"}
                className={kind === "bug" ? "on" : ""}
                onClick={() => setKind("bug")}
              >
                <BugIcon size={14} /> Bug
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={kind === "idea"}
                className={kind === "idea" ? "on" : ""}
                onClick={() => setKind("idea")}
              >
                <StarIcon size={14} /> Suggestion
              </button>
            </div>

            <label className="bug-field">
              <span className="small muted">
                {kind === "bug" ? "What went wrong, and what did you expect?" : "What would make it better?"}
              </span>
              <textarea
                value={message}
                maxLength={MESSAGE_MAX}
                rows={5}
                autoFocus
                placeholder={
                  kind === "bug"
                    ? "e.g. The token modal stays blank after I tap a card on the Live tab."
                    : "e.g. Let me sort the feed by holder count."
                }
                onChange={(e) => setMessage(e.target.value)}
              />
              <span className="small faint bug-count">
                {trimmed.length}/{MESSAGE_MAX}
              </span>
            </label>

            {(canCapture || screenshot || imageNote) && (
              <div className="bug-shot">
                {screenshot ? (
                  <figure className="bug-shot-preview">
                    <img src={screenshot} alt="Attached screenshot" />
                    <button
                      type="button"
                      className="ghost icon-btn danger"
                      onClick={() => setScreenshot(null)}
                      aria-label="Remove the screenshot"
                      title="Remove the screenshot"
                    >
                      <TrashIcon size={15} />
                    </button>
                  </figure>
                ) : (
                  canCapture && (
                    <div className="bug-shot-actions">
                      <button
                        type="button"
                        className="ghost small-btn"
                        disabled={capturing}
                        onClick={() => void capture()}
                      >
                        Capture this screen
                      </button>
                      <span className="small faint">Optional</span>
                    </div>
                  )
                )}
                {imageNote && <p className="small muted">{imageNote}</p>}
              </div>
            )}

            <label className="bug-field">
              <span className="small muted">How can we reach you? (optional)</span>
              <input
                type="text"
                value={contact}
                maxLength={CONTACT_MAX}
                placeholder="Telegram @handle, X or email"
                onChange={(e) => setContact(e.target.value)}
              />
            </label>

            {/* Hidden from people; bots that fill every field get dropped. */}
            <input
              className="bug-hp"
              type="text"
              name="website"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden
              value={honeypot}
              onChange={(e) => setHoneypot(e.target.value)}
            />

            <p className="small faint bug-sends">
              Sent with it: this page ({where.tab}), the app version, your screen size and browser
              {where.walletAddress ? `, and your wallet ${shortAddress(where.walletAddress)}` : ""}.
            </p>

            {error && (
              <p className="error small" role="alert">
                {error}
              </p>
            )}

            <div className="bug-actions">
              <button type="button" className="ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="button primary" disabled={busy || !trimmed}>
                {busy ? "Sending…" : kind === "bug" ? "Send report" : "Send suggestion"}
              </button>
            </div>
          </form>
        )}
      </div>
    </dialog>
  );
}
