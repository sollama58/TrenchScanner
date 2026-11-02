import { useState } from "react";
import type { ModelsVsKols, VsRow } from "../api";
import { AsOf } from "../components/AsOf";
import { KolAvatar } from "../components/KolAvatar";
import { ShareIcon, TargetIcon } from "../components/Icons";
import { ShareImageDialog } from "../components/ShareImageDialog";
import { Skeleton } from "../components/Skeleton";
import { usePolling } from "../hooks";
import { MIN_GRADED_FOR_RATE, RULE_NOTE, isEarly } from "../rates";
import { renderVsKolsCard } from "./vsKolsCard";
import {
  TIERS,
  TIER_TEXT,
  edge,
  leaderOf,
  rateOf,
  rateText,
  sideTotal,
  tiersAt,
  windowName,
  type Tier,
} from "./vsKolsView";

/**
 * "Models vs KOLs" (user ask 2026-11-02): the top three models' 2x, 4x and 10x rates over 24h,
 * 3 days and 7 days beside the KOLs we track, near the top of the Models tab, with a share image.
 * The figures and what counts as a KOL's call are the API's (apps/api modelsVsKols.ts).
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
        <h3>Top models vs top KOLs</h3>
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
  const ranked = [...d.models, ...d.kols];
  const modelsTotal = sideTotal(d.models, shown);
  const kolsTotal = sideTotal(d.kols, shown);
  const empty = d.models.length === 0 && d.kols.length === 0;

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
          <h3>Top {d.models.length || d.rule.topModels} models vs top KOLs</h3>
          <p className="muted small">
            The three models the default feed follows, against the KOLs whose picks did best. Both sides are
            graded the same way: from the moment our clock starts on a coin, did it reach 2x within 15
            minutes, 4x within 30 or 10x within the hour, before a 50% stop.
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
            aria-label={`Each side's calls together, last ${windowName(shown)}`}
          >
            {TIERS.map((tier) => {
              const m = rateOf(modelsTotal, tier);
              const k = rateOf(kolsTotal, tier);
              const e = edge(m, k);
              const max = Math.max(m.pct ?? 0, k.pct ?? 0, targets[tier], 1);
              return (
                <div key={tier} className="vk-duel-tile" role="listitem">
                  <div className="vk-duel-top">
                    <span className="vk-tier">{tier}</span>
                    <span className="faint small">{TIER_TEXT[tier].replace(`${tier} `, "")}</span>
                  </div>
                  <DuelBar side="models" label="Models" rate={m} max={max} />
                  <DuelBar side="kols" label="KOLs" rate={k} max={max} />
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
              <Row key={r.id} row={r} index={i} days={shown} ranked={ranked} targets={targets} />
            ))}
            <Group label="KOLs" note={`best 2x record over ${windowName(d.rule.rankDays)}`} />
            {d.kols.length === 0 && (
              <p className="empty small">
                No KOL has {d.rule.minGraded} graded picks over {windowName(d.rule.rankDays)} yet.
              </p>
            )}
            {d.kols.map((r, i) => (
              <Row key={r.id} row={r} index={i} days={shown} ranked={ranked} targets={targets} />
            ))}
            <Row row={d.allKols} index={0} days={shown} ranked={[]} targets={targets} pooled />
          </div>
        </>
      )}

      <p className="faint small vk-note">
        A KOL&apos;s pick is a coin we tracked that they bought before our clock started on it, so a coin that
        had already run can&apos;t count for them; their own entry was at or below the price the grade starts
        from. A Known Side counts as its KOL. KOLs are ranked by the low end of their 2x rate&apos;s 90%
        range, so a few lucky picks don&apos;t outrank a long record. Rates on fewer than{" "}
        {MIN_GRADED_FOR_RATE} graded are faded, and a row's bar fills at the goal. {RULE_NOTE}{" "}
        <AsOf computedAt={d.computedAt} now={now} />
      </p>

      {sharing && (
        <ShareImageDialog
          title={`Top models vs top KOLs, last ${windowName(shown)}`}
          fileName={`trenchscanner-models-vs-kols-${windowName(shown).replace(" ", "-")}`}
          caption={`TrenchScanner's top models vs the top KOLs, last ${windowName(shown)}`}
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

function DuelBar({
  side,
  label,
  rate,
  max,
}: {
  side: "models" | "kols";
  label: string;
  rate: ReturnType<typeof rateOf>;
  max: number;
}) {
  const early = isEarly(rate.n);
  return (
    <div
      className={`vk-duel-bar ${side}${early ? " early" : ""}`}
      title={rate.n ? `${rate.wins} of ${rate.n}` : "Nothing graded"}
    >
      <span className="vk-duel-label">{label}</span>
      <span className="vk-track" aria-hidden="true">
        <i style={{ width: `${Math.min(100, ((rate.pct ?? 0) / max) * 100)}%` }} />
      </span>
      <span className="vk-duel-value">{rateText(rate.pct)}</span>
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

function Row({
  row,
  index,
  days,
  ranked,
  targets,
  pooled = false,
}: {
  row: VsRow;
  index: number;
  days: number;
  ranked: readonly VsRow[];
  targets: TierTargets;
  pooled?: boolean;
}) {
  const t = tiersAt(row, days);
  const side = row.kind === "model" ? "models" : "kols";
  return (
    <div className={`vk-row ${side}${pooled ? " pooled" : ""}`} role="row">
      <span className="vk-name" role="rowheader">
        {pooled ? (
          <span className="vk-mark pooled" aria-hidden="true">
            ∑
          </span>
        ) : row.kind === "kol" ? (
          <KolAvatar
            src={row.avatar}
            className="vk-mark vk-pic"
            fallback={
              <span className="vk-mark kols" aria-hidden="true">
                {(row.name.trim()[0] ?? "?").toUpperCase()}
              </span>
            }
          />
        ) : (
          <span className="vk-mark models" aria-hidden="true">
            {index + 1}
          </span>
        )}
        <span className="vk-who">
          <span className="vk-title">
            {row.kind === "kol" && row.twitter ? (
              <a
                href={`https://x.com/${encodeURIComponent(row.twitter)}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {row.name}
              </a>
            ) : (
              row.name
            )}
          </span>
          <span className="faint small">
            {(t?.graded ?? 0).toLocaleString()} graded {row.kind === "model" ? "calls" : "picks"}
            {pooled ? ", each coin once" : ""}
          </span>
        </span>
      </span>
      {TIERS.map((tier) => {
        const r = rateOf(t, tier);
        const lead = !pooled && leaderOf(ranked, days, tier, MIN_GRADED_FOR_RATE) === row.id;
        const early = isEarly(r.n);
        const width = r.pct === null ? 0 : Math.min(100, (r.pct / Math.max(targets[tier], 1)) * 100);
        return (
          <span
            key={tier}
            role="cell"
            className={`vk-cell${lead ? " lead" : ""}${early ? " early" : ""}`}
            title={`${TIER_TEXT[tier]}: ${r.n ? `${r.wins} of ${r.n}` : "nothing graded"}${early && r.n ? " (too few to read)" : ""}`}
          >
            <span className="vk-rate">{rateText(r.pct)}</span>
            <span className="vk-track" aria-hidden="true">
              <i style={{ width: `${width}%` }} />
            </span>
          </span>
        );
      })}
    </div>
  );
}
