import { usePolling } from "../hooks";

export interface ReportCounts {
  new: number;
  seen: number;
  done: number;
}

export const REPORT_COUNTS_PATH = "/admin/feedback/counts";

/** On the Admin tab (admins only): how many bug reports and suggestions nobody has looked at. */
export function AdminReportsBadge() {
  const { data } = usePolling<ReportCounts>(REPORT_COUNTS_PATH, 120_000);
  if (!data?.new) return null;
  return (
    <span className="reports-badge" title={`${data.new} new report${data.new === 1 ? "" : "s"}`}>
      {data.new > 99 ? "99+" : data.new}
    </span>
  );
}
