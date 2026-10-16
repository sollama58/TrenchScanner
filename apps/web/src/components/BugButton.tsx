import { Suspense, lazy, useState } from "react";
import { BugIcon } from "./Icons";
import type { ReportWhere } from "./BugReportDialog";

// The form (and its screenshot code) loads the first time someone presses the button.
const BugReportDialog = lazy(() => import("./BugReportDialog").then((m) => ({ default: m.BugReportDialog })));

/**
 * The bug button: a small round icon fixed at the bottom right of every screen that opens the
 * bug report / suggestion form. Admins read what comes in under Admin > Reports.
 */
export function BugButton(where: ReportWhere) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="bug-fab"
        onClick={() => setOpen(true)}
        aria-label="Report a bug or suggest something"
        title="Report a bug or suggest something"
        aria-haspopup="dialog"
      >
        <BugIcon size={20} />
      </button>
      {open && (
        <Suspense fallback={null}>
          <BugReportDialog {...where} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
