import { useEffect } from "react";
import { usePolling } from "../hooks";

export interface ReportCounts {
  new: number;
  seen: number;
  done: number;
}

export const REPORT_COUNTS_PATH = "/admin/feedback/counts";

const REFRESH_EVENT = "ts:report-counts";

/** Re-reads the counts now: the reports panel calls this after triaging one. */
export function refreshReportCounts(): void {
  window.dispatchEvent(new Event(REFRESH_EVENT));
}

/** On the Admin tab (admins only): how many bug reports and suggestions nobody has looked at. */
export function AdminReportsBadge() {
  const { data, reload } = usePolling<ReportCounts>(REPORT_COUNTS_PATH, 120_000);
  useEffect(() => {
    window.addEventListener(REFRESH_EVENT, reload);
    return () => window.removeEventListener(REFRESH_EVENT, reload);
  }, [reload]);
  if (!data?.new) return null;
  return (
    <span className="reports-badge" title={`${data.new} new report${data.new === 1 ? "" : "s"}`}>
      {data.new > 99 ? "99+" : data.new}
    </span>
  );
}
