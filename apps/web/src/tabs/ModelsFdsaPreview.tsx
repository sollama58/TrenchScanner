import { usePolling } from "../hooks";
import { ArrowRightIcon, RobotIcon } from "../components/Icons";
import { fdsaSignedPct, type FdsaRate } from "./fdsaView";

/**
 * The Models tab's way into FDSA (user ask 2026-11-12: "add a link to FDSA somewhere in models
 * with a brief preview"). The models pick the alerts; FDSA is Claude reading those alerts and
 * calling buy or no buy, so its headline figures sit next to the models' and link to #fdsa.
 *
 * It reads the same GET /fdsa?days=30 the FDSA page opens on, so the API's shared cache serves
 * both (routes/fdsaPublic.ts). That route is subscriber-only, so a guest gets the words and the
 * link (which opens the guest lock) without the figures.
 */

/** The slice of GET /fdsa this preview shows (FdsaTab.tsx has the whole page). */
interface FdsaPreviewData {
  bankroll: { pnlPct: number | null; trades: number };
  record: { trades: FdsaRate; target: number };
  open: unknown[];
}

const FDSA_DAYS = 30;

export function ModelsFdsaPreview({ guest = false }: { guest?: boolean }) {
  return (
    <section className="panel fdsa-preview">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <RobotIcon size={13} /> FDSA · Claude&apos;s paper trading desk
          </span>
          <h3>Which alerts would Claude buy?</h3>
          <p className="muted small">
            Claude reads the curated alerts these models make, calls buy or no buy on each, and runs its own
            exits on the buys. It trades paper money at real prices, graded on the same 2x in 15 minutes rule.
          </p>
        </div>
        <a className="button primary" href="#fdsa">
          Open FDSA <ArrowRightIcon size={13} />
        </a>
      </header>
      {!guest && <FdsaFigs />}
    </section>
  );
}

function FdsaFigs() {
  const q = usePolling<FdsaPreviewData>(`/fdsa?days=${FDSA_DAYS}`, 120_000);
  const d = q.data;
  if (!d) return q.error ? null : <div className="family-figs" aria-busy="true" />;
  const t = d.record.trades;
  return (
    <div className={`family-figs${q.stale ? " stale" : ""}`}>
      <div>
        <label>Paper P&amp;L</label>
        <span className="num">{d.bankroll.trades === 0 ? "–" : fdsaSignedPct(d.bankroll.pnlPct)}</span>
      </div>
      <div>
        <label>2x hit rate ({FDSA_DAYS}d)</label>
        <span className="num">
          {t.rate === null ? "–" : `${Math.round(t.rate * 100)}%`}
          <span className="muted small">
            {" "}
            of {t.graded} · target {Math.round(d.record.target * 100)}%
          </span>
        </span>
      </div>
      <div>
        <label>Trades</label>
        <span className="num">
          {d.bankroll.trades}
          <span className="muted small"> · {d.open.length} open</span>
        </span>
      </div>
    </div>
  );
}
