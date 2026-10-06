import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CloseIcon, InfoIcon } from "./Icons";

/** The composite score in one line, for hover titles. */
export const SCORE_SUMMARY =
  "0-100: how much a token looks like the launches that double fast, from its last 5 minutes, its age and its holders.";

/**
 * A small info button that opens a plain-words explanation of the token composite score (the
 * "Min composite score" filter setting). A modal rather than a hover tooltip, so it works on
 * phones too; the button's title carries the one-line summary for a quick hover on desktop. The
 * dialog is portaled to the body: the button sits inside the field's <label>, and a dialog inside
 * it would send its clicks to the label's input.
 *
 * Keep in step with packages/core/src/scoring/scorer.ts.
 */
export function ScoreExplainer() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="ghost icon-btn info-btn"
        title={SCORE_SUMMARY}
        aria-label="What the composite score means"
        onClick={() => setOpen(true)}
      >
        <InfoIcon size={14} />
      </button>
      {createPortal(<ScoreExplainerModal open={open} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function ScoreExplainerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="about-modal sheet-modal"
      aria-labelledby="score-explainer-title"
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself; clicks inside land on its content.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="about-body">
        <header className="about-head">
          <h2 id="score-explainer-title">The composite score</h2>
          <button type="button" className="ghost icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </header>
        <p>
          A 0-100 read, refreshed every scan, of how much a token looks like the launches that double within
          15 minutes. It is built from four parts:
        </p>
        <dl className="about-terms">
          <dt>Momentum · 45%</dt>
          <dd>
            The last 5 minutes: how far the price moved, trading volume against market cap, the share of
            trades that are buys, and holder growth over 10 minutes.
          </dd>
          <dt>Freshness · 30%</dt>
          <dd>Younger scores higher. Most fast doubles happen in a launch&apos;s first 10 minutes.</dd>
          <dt>Holders · 10%</dt>
          <dd>
            Few empty wallets in the top 10, and the first buyers still holding. A launch still on the bonding
            curve whose top 10 hold 15% or less scores 0 here: those rarely double.
          </dd>
          <dt>Narrative · 15%</dt>
          <dd>
            Held at the midpoint for now. It will read what the coin is about once narrative data is added.
          </dd>
        </dl>
        <h3>Reading the number</h3>
        <p>
          Most fresh launches score between 60 and 88. On recent filter matches, tokens scoring 80 or more
          doubled about 16% of the time, against 12% for all matches.
        </p>
        <p>
          It is a quick screen, not the models&apos; call: the models read the raw numbers themselves. A min
          score in a filter drops tokens below it.
        </p>
      </div>
    </dialog>
  );
}
