import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { WorkerHealth } from "../api";
import { usePolling } from "../hooks";
import { ago } from "../format";

/** Past this, a stage that normally produces every few minutes reads as stalled in the tooltip. */
const STAGE_STALE_MS = 15 * 60_000;

/** "42s ago", "12m 5s ago", "3h 10m ago": finer than ago(), since a stall is minutes long. */
function since(iso: string | null | undefined, now: number): string {
  if (!iso) return "not yet";
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * The scanner's health, from the public worker heartbeat, as a pill in a feed's header (Live feed,
 * Stream, guest feed) with a card of when each stage of the alert path last produced. The card
 * opens on hover, keyboard focus, or a tap on touch screens (a tap elsewhere closes it).
 *
 * `showJobs`: the per-job rows, for admin wallets only - everyone else sees the alert pipeline.
 * `feed`: how this feed itself is updating (pushed live, or polling), as a row in the card.
 */
export function ScanStatus({
  showJobs = false,
  feed,
}: {
  showJobs?: boolean;
  feed?: { live: boolean; idle: string };
}) {
  const { data } = usePolling<WorkerHealth>("/health/worker", 30_000);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const tipId = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  // The pointer that pressed the pill last: a mouse opens the card by hovering, a finger by tapping.
  const pointer = useRef<string>("mouse");
  // The ages count up live: every second while the card is showing, every 15s for the pill, so a
  // heartbeat held while the API can't be reached (or restored from an earlier visit) ages too.
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), open ? 1000 : 15_000);
    return () => clearInterval(id);
  }, [open]);
  // The card hangs from the pill's right edge; where the pill sits near a narrow screen's left edge
  // (a phone's wrapped feed controls), it slides right so it stays on screen.
  const tip = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    if (!open || !wrap.current || !tip.current) return;
    const right = wrap.current.getBoundingClientRect().right;
    setShift(Math.max(0, 16 - (right - tip.current.offsetWidth)));
  }, [open]);
  // A tap anywhere outside closes a card a tap opened.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const scan = data?.jobs.find((j) => j.job === "scan");
  // Until the heartbeat lands, an invisible pill of the usual size holds its place, so the feed's
  // controls don't shift when the real one appears.
  if (!data)
    return (
      <span className="status-wrap" aria-hidden style={{ visibility: "hidden" }}>
        <span className="status-pill">
          <span className="pulse" />
          Scanning<span className="faint"> · 10s ago</span>
        </span>
      </span>
    );
  // Only the scan loop decides the pill: daily jobs (cleanup, outcome tracking) read as stale for
  // most of the day by design, and the user is asking "is it finding tokens right now".
  // The server judged staleness when it answered; a held answer is judged again against the clock,
  // so a pill whose polls keep failing turns to lagging instead of staying green.
  // A loop that runs but fails every cycle keeps lastRunAt fresh, so its last success is judged
  // against the same threshold.
  const past = (iso: string | null) =>
    scan?.staleAfterMs != null && (!iso || now - new Date(iso).getTime() > scan.staleAfterMs);
  const bad = !scan || scan.stale || scan.hung || past(scan.lastRunAt) || past(scan.lastSuccessAt);
  const p = data.pipeline;
  const stages = p
    ? [
        { label: "Last alert by any model", at: p.lastAlertAt },
        { label: "Last token passed pre-check", at: p.lastPreCheckPassAt },
        { label: "Last token back from TokenSage", at: p.lastTokenSageAt },
        { label: "Last token considered by any model", at: p.lastDecisionAt },
      ]
    : [];
  const mouse = (e: React.PointerEvent) => e.pointerType === "mouse";
  return (
    <span
      ref={wrap}
      className="status-wrap"
      onPointerEnter={(e) => mouse(e) && setOpen(true)}
      onPointerLeave={(e) => mouse(e) && setOpen(false)}
      onBlur={() => setOpen(false)}
    >
      <span
        role="button"
        tabIndex={0}
        aria-label={bad ? "Scanner lagging" : "Scanning"}
        aria-describedby={tipId}
        aria-expanded={open}
        className={`status-pill ${bad ? "warn" : "ok"}`}
        onPointerDown={(e) => {
          pointer.current = e.pointerType;
        }}
        // Keyboard focus opens it; the focus a tap brings is left to the tap below.
        onFocus={(e) => e.currentTarget.matches(":focus-visible") && setOpen(true)}
        onClick={() => {
          if (pointer.current !== "mouse") setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
      >
        <span className="pulse" />
        {bad ? "Scanner lagging" : "Scanning"}
        {scan && <span className="faint"> · {ago(scan.lastSuccessAt, now)}</span>}
      </span>
      <span
        ref={tip}
        id={tipId}
        role="tooltip"
        className={`status-tip${open ? " open" : ""}`}
        style={shift ? { right: -shift } : undefined}
      >
        {feed && (
          <>
            <span className="status-tip-head">This feed</span>
            <span className="status-tip-row">
              <span className={`status-tip-dot ${feed.live ? "ok" : "idle"}`} />
              <span className="status-tip-label">Updates</span>
              <span className="status-tip-val">{feed.live ? "Live" : feed.idle}</span>
            </span>
          </>
        )}
        {stages.length > 0 && (
          <>
            <span className="status-tip-head">Alert pipeline</span>
            {stages.map((st) => {
              const late = !st.at || now - new Date(st.at).getTime() > STAGE_STALE_MS;
              return (
                <span key={st.label} className="status-tip-row">
                  <span className={`status-tip-dot ${late ? "warn" : "ok"}`} />
                  <span className="status-tip-label">{st.label}</span>
                  <span className={`status-tip-val num${late ? " warn" : ""}`}>{since(st.at, now)}</span>
                </span>
              );
            })}
          </>
        )}
        {showJobs && (
          <>
            <span className="status-tip-head">Jobs</span>
            {data.jobs.map((j) => {
              const late = j.stale || j.hung;
              return (
                <span key={j.job} className="status-tip-row">
                  <span className={`status-tip-dot ${late ? "warn" : "ok"}`} />
                  <span className="status-tip-label">{j.job}</span>
                  <span className={`status-tip-val num${late ? " warn" : ""}`}>
                    {j.hung ? "running too long" : since(j.lastSuccessAt, now)}
                  </span>
                </span>
              );
            })}
          </>
        )}
      </span>
    </span>
  );
}
