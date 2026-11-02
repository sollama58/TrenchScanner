import { useState } from "react";
import type { KolTypical, ModelsVsKols, VsRow } from "../api";
import { AsOf } from "../components/AsOf";
import { ShareIcon, TargetIcon } from "../components/Icons";
import { ShareImageDialog } from "../components/ShareImageDialog";
import { Skeleton } from "../components/Skeleton";
import { usePolling } from "../hooks";
import { MIN_GRADED_FOR_RATE, RULE_NOTE, isEarly } from "../rates";
import { renderVsKolsCard } from "./vsKolsCard";
import {
  KOL_BASIS,
  KOL_ID,
  MIN_KOLS_TO_LEAD,
  TIERS,
  TIER_TEXT,
  edge,
  kolAt,
  kolRate,
  leaderOf,
  rateOf,
  rateText,
  sideTotal,
  tiersAt,
  windowName,
  type Tier,
} from "./vsKolsView";

/**
 * "Models vs KOLs" (user asks 2026-11-02): the top three models' 2x, 4x and 10x rates over 24h,
 * 3 days and 7 days beside the typical KOL we track (the average of the KOLs with enough picks in
 * the window), near the top of the Models tab, with a share image. The figures and what counts as
 * a KOL's pick are the API's (apps/api modelsVsKols.ts).
 */

const DEFAULT_DAYS = 7;
const POLL_MS = 300_000;

export type TierTargets = Record<Tier, number>;

export function ModelsVsKolsPanel({ api, targets, now }: { api: string; targets: TierTargets; now: number }) {
  const q = usePolling<ModelsVsKols>(`${api}/models/vs-kols`, POLL_MS);
  const [days, setDays] = useState(DEFAULT_DAYS);
  const [sharing, setSharing] = useState(false);
  const [copied, setCopied] = useState(false);
  const d = q.data;

  if (!d) {
    return (
      <section className="panel vk-panel" aria-busy={!q.error}>
        <span className="eyebrow">
          <TargetIcon size={13} /> Head to head
        </span>
        <h3>Top models vs the typical KOL</h3>
        {q.error ? (
          <p className="error">Couldn&apos;t load the comparison: {q.error.message}</p>
        ) : (
          <Skeleton lines={5} />
        )}
      </section>
    );
  }

  const windows = d.windows.length ? d.windows : [DEFAULT_DAYS];
  const shown = windows.includes(days) ? days : windows[windows.length - 1]!;
  const modelsTotal = sideTotal(d.models, shown);
  const kol = kolAt(d.kol, shown);
  const kolThin = (kol?.kols ?? 0) < MIN_KOLS_TO_LEAD;
  const empty = d.models.length === 0 && !d.kol.some((k) => k.kols > 0);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/#model`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const windowPicker = (label: string) => (
    <div className="segmented small" role="group" aria-label={label}>
      {windows.map((w) => (
        <button
          key={w}
          className={w === shown ? "on" : ""}
          aria-pressed={w === shown}
          onClick={() => setDays(w)}
        >
          {windowName(w)}
        </button>
      ))}
    </div>
  );

  return (
    <section className={`panel vk-panel${q.stale ? " stale" : ""}`} aria-busy={q.stale}>
      <header className="section-head vk-head">
        <div>
          <span className="eyebrow">
            <TargetIcon size={13} /> Head to head
          </span>
          <h3>Top {d.models.length || d.rule.topModels} models vs the typical KOL</h3>
          <p className="muted small">
            The three models the default feed follows, against the average KOL we track. Both sides are graded
            the same way: from the moment our clock starts on a coin, did it reach 2x within 15 minutes, 4x
            within 30 or 10x within the hour, before a 50% stop.
          </p>
        </div>
        <div className="learning-tools vk-tools">
          {windowPicker("Window")}
          <button type="button" className="ghost share-btn" disabled={empty} onClick={() => setSharing(true)}>
            <ShareIcon size={14} /> Share
          </button>
        </div>
      </header>

      {empty ? (
        <p className="empty">No graded calls on either side yet.</p>
      ) : (
        <>
          <div
            className="vk-duel"
            role="list"
            aria-label={`Models vs the typical KOL, last ${windowName(shown)}`}
          >
            {TIERS.map((tier) => {
              const m = rateOf(modelsTotal, tier);
              const k = kolRate(kol, tier);
              const e = edge(m.pct, kolThin ? null : k.shown);
              const max = Math.max(m.pct ?? 0, k.shown ?? 0, targets[tier], 1);
              return (
                <div key={tier} className="vk-duel-tile" role="listitem">
                  <div className="vk-duel-top">
                    <span className="vk-tier">{tier}</span>
                    <span className="faint small">{TIER_TEXT[tier].replace(`${tier} `, "")}</span>
                  </div>
                  <DuelBar
                    side="models"
                    label="Models"
                    pct={m.pct}
                    max={max}
                    faded={isEarly(m.n)}
                    title={m.n ? `Top ${d.models.length} together: ${m.wins} of ${m.n}` : "Nothing graded"}
                  />
                  <DuelBar
                    side="kols"
                    label="KOL"
                    pct={k.shown}
                    max={max}
                    faded={kolThin}
                    title={kolTitle(kol, k)}
                  />
                  <div className="vk-duel-foot">
                    {e === null ? (
                      <span className="faint small">Not enough graded yet</span>
                    ) : e.side === "tie" ? (
                      <span className="vk-edge tie">Level</span>
                    ) : (
                      <span className={`vk-edge ${e.side}`}>
                        {e.side === "models" ? "Models" : "KOLs"} +{e.pts.toFixed(e.pts >= 10 ? 0 : 1)} pts
                      </span>
                    )}
                    <span className="faint small vk-goal">goal {targets[tier]}%</span>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="vk-board" role="table" aria-label={`Hit rates, last ${windowName(shown)}`}>
            <div className="vk-row vk-headrow" role="row">
              <span role="columnheader" className="vk-name">
                Last {windowName(shown)}
              </span>
              {TIERS.map((t) => (
                <span key={t} role="columnheader" className="vk-cell" title={TIER_TEXT[t]}>
                  {t}
                </span>
              ))}
            </div>
            <Group label="Models" note="the default feed's top 3" />
            {d.models.length === 0 && <p className="empty small">No model qualifies for the top 3 yet.</p>}
            {d.models.map((r, i) => (
              <ModelRow key={r.id} row={r} index={i} d={d} days={shown} targets={targets} />
            ))}
            <Group
              label="KOLs"
              note={`KOLs with ${kol?.minPicks ?? "–"}+ graded picks in ${windowName(shown)}`}
            />
            <KolRow kol={kol} d={d} days={shown} targets={targets} />
          </div>
        </>
      )}

      <p className="faint small vk-note">
        The typical KOL is the average of each KOL&apos;s own rate over the window, one KOL one vote, among
        those with at least{" "}
        {d.kol.map((k) => `${k.minPicks} graded picks in ${windowName(k.days)}`).join(", ")} (the median is
        under each figure). A pick is a coin we tracked that they bought before our clock started on it, so a
        coin that had already run can&apos;t count for them, and a Known Side counts as its KOL. The
        models&apos; figures are their calls together. Rates on fewer than {MIN_GRADED_FOR_RATE} graded calls,
        or fewer than {MIN_KOLS_TO_LEAD} KOLs, are faded, and a bar fills at the goal. {RULE_NOTE}{" "}
        <AsOf computedAt={d.computedAt} now={now} />
      </p>

      {sharing && (
        <ShareImageDialog
          title={`Top models vs the typical KOL, last ${windowName(shown)}`}
          fileName={`trenchscanner-models-vs-kols-${windowName(shown).replace(" ", "-")}`}
          caption={`TrenchScanner's top models vs the typical KOL, last ${windowName(shown)}`}
          link="trenchscanner.app"
          drawKey={String(shown)}
          render={() => renderVsKolsCard(d, shown)}
          onClose={() => setSharing(false)}
          controls={
            <div className="row vk-share-controls">
              {windowPicker("Image window")}
              <button type="button" className="ghost" onClick={() => void copyLink()}>
                {copied ? "Link copied" : "Copy link"}
              </button>
            </div>
          }
        />
      )}
    </section>
  );
}

function kolTitle(kol: KolTypical | undefined, k: { median: number | null; mean: number | null }) {
  if (!kol || kol.kols === 0) return "No KOL has enough picks in this window yet";
  return `${kol.kols} KOLs (${kol.picks.toLocaleString()} graded picks): median ${rateText(k.median)}, average ${rateText(k.mean)}`;
}

function DuelBar({
  side,
  label,
  pct,
  max,
  faded,
  title,
}: {
  side: "models" | "kols";
  label: string;
  pct: number | null;
  max: number;
  faded: boolean;
  title: string;
}) {
  return (
    <div className={`vk-duel-bar ${side}${faded ? " early" : ""}`} title={title}>
      <span className="vk-duel-label">{label}</span>
      <span className="vk-track" aria-hidden="true">
        <i style={{ width: `${Math.min(100, ((pct ?? 0) / max) * 100)}%` }} />
      </span>
      <span className="vk-duel-value">{rateText(pct)}</span>
    </div>
  );
}

function Group({ label, note }: { label: string; note: string }) {
  return (
    <div className="vk-group" role="row">
      <span role="rowheader">
        {label} <span className="faint">· {note}</span>
      </span>
    </div>
  );
}

const barWidth = (pct: number | null, target: number) =>
  pct === null ? 0 : Math.min(100, (pct / Math.max(target, 1)) * 100);

function ModelRow({
  row,
  index,
  d,
  days,
  targets,
}: {
  row: VsRow;
  index: number;
  d: ModelsVsKols;
  days: number;
  targets: TierTargets;
}) {
  const t = tiersAt(row, days);
  const kol = kolAt(d.kol, days);
  return (
    <div className="vk-row models" role="row">
      <span className="vk-name" role="rowheader">
        <span className="vk-mark models" aria-hidden="true">
          {index + 1}
        </span>
        <span className="vk-who">
          <span className="vk-title">{row.name}</span>
          <span className="faint small">{(t?.graded ?? 0).toLocaleString()} graded calls</span>
        </span>
      </span>
      {TIERS.map((tier) => {
        const r = rateOf(t, tier);
        const lead = leaderOf(d.models, kol, days, tier, MIN_GRADED_FOR_RATE) === row.id;
        const early = isEarly(r.n);
        return (
          <span
            key={tier}
            role="cell"
            className={`vk-cell${lead ? " lead" : ""}${early ? " early" : ""}`}
            title={`${TIER_TEXT[tier]}: ${r.n ? `${r.wins} of ${r.n}` : "nothing graded"}${early && r.n ? " (too few to read)" : ""}`}
          >
            <span className="vk-rate">{rateText(r.pct)}</span>
            <span className="vk-track" aria-hidden="true">
              <i style={{ width: `${barWidth(r.pct, targets[tier])}%` }} />
            </span>
          </span>
        );
      })}
    </div>
  );
}

function KolRow({
  kol,
  d,
  days,
  targets,
}: {
  kol: KolTypical | undefined;
  d: ModelsVsKols;
  days: number;
  targets: TierTargets;
}) {
  const thin = (kol?.kols ?? 0) < MIN_KOLS_TO_LEAD;
  return (
    <div className="vk-row kols" role="row">
      <span className="vk-name" role="rowheader">
        <span className="vk-mark kols" aria-hidden="true">
          K
        </span>
        <span className="vk-who">
          <span className="vk-title">The typical KOL</span>
          <span className="faint small">
            {kol && kol.kols > 0
              ? `average of ${kol.kols} KOL${kol.kols === 1 ? "" : "s"}, ${kol.picks.toLocaleString()} graded picks`
              : "no KOL has enough picks yet"}
          </span>
        </span>
      </span>
      {TIERS.map((tier) => {
        const k = kolRate(kol, tier);
        const lead = leaderOf(d.models, kol, days, tier, MIN_GRADED_FOR_RATE) === KOL_ID;
        return (
          <span
            key={tier}
            role="cell"
            className={`vk-cell${lead ? " lead" : ""}${thin ? " early" : ""}`}
            title={`${TIER_TEXT[tier]}: ${kolTitle(kol, k)}`}
          >
            <span className="vk-rate">{rateText(k.shown)}</span>
            <span className="vk-track" aria-hidden="true">
              <i style={{ width: `${barWidth(k.shown, targets[tier])}%` }} />
            </span>
            <span className="vk-avg faint">
              {KOL_BASIS[tier] === "median" ? `avg ${rateText(k.mean)}` : `median ${rateText(k.median)}`}
            </span>
          </span>
        );
      })}
    </div>
  );
}
