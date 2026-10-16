import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CheckIcon } from "./Icons";

/**
 * The pieces every popup draws while a part of it is still loading (user ask 2026-10-16): a value
 * placeholder the size of the reading it stands for, a line saying what is being read (and, past
 * a while, that it is still going and for how long), and a scan's steps as they land.
 */

/** Seconds since this mounted (or since `from`), ticking once a second while `on`. */
export function useElapsed(on = true, from?: number): number {
  const [start] = useState(() => from ?? Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [on]);
  return Math.max(0, Math.floor((now - start) / 1000));
}

/** A shimmering bar in place of a reading still loading: about as wide as the reading will be. */
export function SkelValue({ width = "3.2em", style }: { width?: string; style?: CSSProperties }) {
  return <span className="skeleton skel-value" style={{ width, ...style }} aria-hidden="true" />;
}

/** A small spinner, drawn in the text colour. */
export function Spinner({ size = 12 }: { size?: number }) {
  return <span className="ld-spin" style={{ width: size, height: size }} aria-hidden="true" />;
}

/**
 * What is loading, in words, with a spinner. After `slowAfterMs` it says it is still going and
 * how long it has taken (`slow` replaces the text then, when given).
 */
export function LoadingNote({
  children,
  slow,
  slowAfterMs = 8000,
  className = "",
}: {
  children: ReactNode;
  slow?: ReactNode;
  slowAfterMs?: number;
  className?: string;
}) {
  const secs = useElapsed();
  const late = secs * 1000 >= slowAfterMs;
  return (
    <p className={`ld-note small ${className}`} role="status" aria-live="polite">
      <Spinner />
      <span>
        {late && slow ? slow : children}
        {late && <span className="faint num"> · {secs}s</span>}
      </span>
    </p>
  );
}

/** A scan's parts, each ticked as it lands. */
export function LoadSteps({ steps }: { steps: { label: string; done: boolean }[] }) {
  return (
    <ul className="ld-steps" aria-label="Progress">
      {steps.map((s) => (
        <li key={s.label} className={s.done ? "done" : "busy"}>
          {s.done ? <CheckIcon size={11} /> : <Spinner size={10} />}
          <span>{s.label}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Opens its content from nothing instead of dropping it in: for a card that only shows when its
 * read finds something, so what is below slides down rather than jumping.
 */
export function Reveal({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // Laid out closed first, then opened, so the change animates.
    void ref.current?.offsetHeight;
    const frame = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div ref={ref} className={`ld-reveal${open ? " open" : ""}`}>
      <div>{children}</div>
    </div>
  );
}
