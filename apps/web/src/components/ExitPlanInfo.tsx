import { Fragment, useEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { CloseIcon, InfoIcon } from "./Icons";
import { exitPlanExamples, exitPlanShort, exitPlanSteps, useExitPlan } from "../exitPlan";
import { signedPct } from "../format";

/** The button's hover text before the plan has loaded. */
const GENERIC_TITLE = "Every average profit and return here follows one fixed exit plan. Tap for the plan.";

/**
 * The exit plan behind every average profit and return: a small info button (or, with `text`, a
 * link-styled phrase) that opens the plan in a dialog. Like the score explainer it is a dialog
 * rather than a hover tooltip, so it works on phones; the button's title carries the plan in one
 * line for a quick hover on desktop. The dialog is portaled to the body, so a button inside a
 * label, a table header or a <details> menu doesn't hand its clicks to them.
 *
 * The numbers come from the server (exitPlan.ts), the same plan grading uses.
 */
export function ExitPlanInfo({ text }: { text?: string }) {
  const [open, setOpen] = useState(false);
  const { plan } = useExitPlan();
  const title = plan ? `Exit plan: ${exitPlanShort(plan)}. Tap for the details.` : GENERIC_TITLE;
  const onClick = (e: MouseEvent) => {
    // Not the row, label or summary it sits in.
    e.preventDefault();
    e.stopPropagation();
    setOpen(true);
  };
  return (
    <>
      {text ? (
        <button type="button" className="link exit-plan-link" title={title} onClick={onClick}>
          {text}
        </button>
      ) : (
        <button
          type="button"
          className="ghost icon-btn info-btn"
          title={title}
          aria-label="The exit plan behind these returns"
          onClick={onClick}
        >
          <InfoIcon size={14} />
        </button>
      )}
      {open && createPortal(<ExitPlanModal onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function ExitPlanModal({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="about-modal sheet-modal"
      aria-labelledby="exit-plan-title"
      // Portaled, but React still bubbles its events up to whatever opened it (often another
      // dialog): keep its close and Escape from closing that too.
      onClose={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      onCancel={(e) => e.stopPropagation()}
      // A click on the backdrop lands on the dialog element itself; clicks inside land on its content.
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="about-body">
        <header className="about-head">
          <h2 id="exit-plan-title">The exit plan</h2>
          <button type="button" className="ghost icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </header>
        <p>
          A hit rate counts each alert as a win or a loss. Average profit and return go further: they run
          every graded alert through one fixed plan, the same for every model and every feed, and average what
          it made.
        </p>
        <ExitPlanDetails />
      </div>
    </dialog>
  );
}

/** The plan step by step, worked examples and the caveats; the popup's body, also used inline. */
export function ExitPlanDetails() {
  const { plan, failed } = useExitPlan();
  if (!plan) {
    return (
      <p className="muted small">
        {failed ? "The exit plan couldn't be loaded just now." : "Loading the exit plan…"}
      </p>
    );
  }
  return (
    <div className="exit-plan">
      <dl className="about-terms">
        {exitPlanSteps(plan).map((s) => (
          <Fragment key={s.title}>
            <dt>{s.title}</dt>
            <dd>{s.body}</dd>
          </Fragment>
        ))}
      </dl>
      <h3>Worked examples</h3>
      <ul className="exit-plan-examples small">
        {exitPlanExamples(plan).map((e) => (
          <li key={e.label}>
            <span>{e.label}</span>
            <span className={`num ${e.returnPct >= 0 ? "up" : "down"}`}>{signedPct(e.returnPct)}</span>
          </li>
        ))}
      </ul>
      <p className="muted small">
        A simulation, not a promise. Prices are checked about once a minute, and the sales and the stop are
        booked at their level; in a fast dump a real stop can fill lower. The trailing stop books the price
        actually seen under its level. Alerts whose last price is unknown are left out rather than guessed.
      </p>
    </div>
  );
}
