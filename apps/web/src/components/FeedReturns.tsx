import { useState } from "react";
import type { FeedReturns as FeedReturnsData } from "../api";
import { usePolling } from "../hooks";
import { multiple, pct, signedPct } from "../format";
import { PnlShare } from "./PnlShare";

const LABELS: Record<number, string> = { 1: "1h", 6: "6h", 24: "24h", 168: "7d" };

const tone = (v: number | null) => (v === null ? "" : v >= 0 ? "lh-up" : "lh-down");

/** A bucket's start as the chart's axis reads it: a clock time inside a day, a weekday past it. */
function bucketLabel(at: string, bucketMinutes: number): string {
  const d = new Date(at);
  if (bucketMinutes >= 360) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: bucketMinutes < 60 ? "2-digit" : undefined,
  });
}

/**
 * The Stats panel's average returns: what the feed's alerts paid under the fixed exit plan over
 * the last hour, 6 hours, day and week, and the selected window's bars. Mounted only while the
 * panel is open, so nobody's closed panel polls for it.
 */
export function FeedReturns({ pollKey }: { pollKey: string }) {
  const { data, error } = usePolling<FeedReturnsData>("/matches/returns", 60_000, pollKey);
  const [hours, setHours] = useState(24);
  const [hover, setHover] = useState<number | null>(null);
  const [sharing, setSharing] = useState<number | null>(null);
  const win = data?.windows.find((w) => w.hours === hours) ?? null;
  const retAbs = Math.max(5, ...(win?.buckets ?? []).map((b) => Math.abs(b.avgReturnPct ?? 0)));
  const focus = win && hover !== null ? (win.buckets[hover] ?? null) : null;

  return (
    <section className="panel feed-returns">
      <span className="eyebrow">Average return</span>
      <div className="returns-tiles" role="tablist" aria-label="Window">
        {(
          data?.windows ??
          [1, 6, 24, 168].map((h) => ({ hours: h, avgReturnPct: null, settled: 0, alerts: 0 }))
        ).map((w) => (
          <button
            key={w.hours}
            type="button"
            role="tab"
            aria-selected={w.hours === hours}
            className={`returns-tile${w.hours === hours ? " on" : ""}`}
            onClick={() => {
              setHours(w.hours);
              setHover(null);
            }}
          >
            <span className="faint small">{LABELS[w.hours] ?? `${w.hours}h`}</span>
            <span className={`returns-value num ${tone(w.avgReturnPct)}`}>
              {signedPct(w.avgReturnPct, 1)}
            </span>
            <small className="faint">{data ? `${w.settled} of ${w.alerts} settled` : "Loading…"}</small>
          </button>
        ))}
      </div>
      {error && !data && <p className="error small">Couldn&apos;t load returns: {error.message}</p>}
      {win && (
        <>
          <p className="small muted returns-focus">
            {focus ? (
              <>
                {bucketLabel(focus.at, win.bucketMinutes)}:{" "}
                <span className={`num ${tone(focus.avgReturnPct)}`}>{signedPct(focus.avgReturnPct, 1)}</span>{" "}
                over {focus.settled} settled
              </>
            ) : win.settled > 0 ? (
              <>
                {win.profitable} of {win.settled} settled alerts made money (
                {pct((win.profitable / win.settled) * 100, 0)})
              </>
            ) : (
              "No settled alerts in this window yet"
            )}
          </p>
          <div className="lh-rate-chart">
            <span className="lh-yaxis" aria-hidden>
              <span>+{Math.round(retAbs)}%</span>
              <span>0%</span>
              <span>−{Math.round(retAbs)}%</span>
            </span>
            <div
              className="lh-ret"
              role="img"
              aria-label={`Average return per ${win.bucketMinutes < 60 ? `${win.bucketMinutes} minutes` : `${win.bucketMinutes / 60} hours`}, ${signedPct(win.avgReturnPct, 1)} overall`}
              onMouseLeave={() => setHover(null)}
            >
              {win.buckets.map((b, i) => {
                const v = b.avgReturnPct ?? 0;
                return (
                  <div
                    key={b.at}
                    className={`lh-ret-col${hover === i ? " is-hover" : ""}`}
                    onMouseEnter={() => setHover(i)}
                    onClick={() => setHover(i)}
                  >
                    {b.avgReturnPct !== null && (
                      <span
                        className={`lh-ret-bar ${v >= 0 ? "up" : "down"}`}
                        style={{ height: `${Math.max(0.5, (Math.abs(v) / retAbs) * 50)}%` }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="lh-axis lh-axis-inset" aria-hidden>
            {win.buckets.map((b, i) => (
              <span key={b.at}>
                {i % Math.ceil(win.buckets.length / 6) === 0 ? bucketLabel(b.at, win.bucketMinutes) : ""}
              </span>
            ))}
          </div>
        </>
      )}
      {data?.top && data.top.length > 0 && (
        <>
          <span className="eyebrow returns-top-head">Top 3 · last 7 days</span>
          <ol className="returns-top">
            {data.top.map((t, i) => (
              <li key={t.tokenId}>
                <span className="returns-rank num">{i + 1}</span>
                <span className="returns-token">
                  <strong>{t.symbol ? `$${t.symbol}` : "Unnamed token"}</strong>
                  <small className="faint">
                    {new Date(t.at).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                    {t.source ? ` · ${t.source.name}` : ""}
                  </small>
                </span>
                <span className={`returns-x num ${tone(t.returnPct)}`}>{multiple(t.returnPct)}</span>
                <button
                  type="button"
                  className="ghost small"
                  aria-expanded={sharing === i}
                  onClick={() => setSharing(sharing === i ? null : i)}
                >
                  {sharing === i ? "Close" : "Share"}
                </button>
              </li>
            ))}
          </ol>
          {sharing !== null && data.top[sharing] && (
            <PnlShare
              key={data.top[sharing]!.tokenId}
              data={{ ...data.top[sharing]!, source: data.top[sharing]!.source ?? null }}
              onClose={() => setSharing(null)}
            />
          )}
        </>
      )}
      <p className="faint small stats-note">
        Each alert&apos;s return under the fixed exit plan (half sold at 2x, the rest on a trailing stop, stop
        at −50%), averaged by when it alerted. An alert counts once its return settles, from 30 minutes to 3
        hours after it fires, so the last hour fills in late.
      </p>
    </section>
  );
}
