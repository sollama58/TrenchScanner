import { useState } from "react";
import type { Leaderboard } from "../api";
import { BrainIcon } from "./Icons";
import { saveFeedSettings } from "./ModelPicker";
import { usePolling } from "../hooks";

/**
 * Settings › Your feed: the Model alerts switch, whether the models' calls join your filter's
 * alerts on the Live feed (user decision 2026-10-15), and under it "Only alerts both caught", which
 * narrows the feed to your active filters' alerts on tokens one of your models also called (user
 * request 2026-10-16, off by default). The feed's numbers are the Live feed's Stats button; which
 * models' calls you get is picked on the Models tab.
 *
 * "Only alerts both caught" needs both halves, so it can't be switched on while Model alerts is off
 * or no filter is switched on; it can always be switched off, and while Model alerts is off a saved
 * "on" waits without applying.
 */
export function FeedPanel({ goTo }: { goTo: (tab: "model" | "filters") => void }) {
  // Bumped when the switch changes, so the board refetches at once.
  const [pick, setPick] = useState(0);
  const [toggling, setToggling] = useState<"models" | "both" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const board = usePolling<Leaderboard>("/curated/models?days=30", 120_000, String(pick));
  const lb = board.data;
  const modelsOn = lb?.showModelAlerts ?? true;
  const bothOn = lb?.bothOnly ?? false;
  const chosen = lb ? lb.entries.filter((e) => lb.selectedModels.includes(e.id)).map((e) => e.name) : [];
  // The switched-on filters, from the board's feed catch (unknown on an older API or a failed read).
  const activeFilters = lb?.feedCatch?.filters.count ?? null;
  const bothBlocked = !modelsOn ? "models" : activeFilters === 0 ? "filters" : null;

  const toggle = async (which: "models" | "both") => {
    setToggling(which);
    setError(null);
    try {
      await saveFeedSettings(which === "models" ? { showModelAlerts: !modelsOn } : { bothOnly: !bothOn });
      setPick((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setToggling(null);
    }
  };

  return (
    <section className="panel feed-panel">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <BrainIcon size={13} /> Your feed
          </span>
          <h2>Model alerts</h2>
        </div>
      </header>
      <div className="tab-option">
        <button
          type="button"
          role="switch"
          aria-checked={modelsOn}
          className={`switch${modelsOn ? " on" : ""}`}
          disabled={!lb || toggling !== null || board.stale}
          onClick={() => void toggle("models")}
        >
          <span className="switch-track">
            <span className="switch-thumb" />
          </span>
          Model alerts
        </button>
        <p className="muted small">
          {modelsOn && bothOn ? (
            <>
              The models&apos; alerts ({chosen.join(", ") || "–"}) show on your Live feed only where your
              filter caught the same token (see below).{" "}
            </>
          ) : modelsOn ? (
            <>
              The models&apos; alerts ({chosen.join(", ") || "–"}) show on your Live feed beside your
              filter&apos;s alerts.{" "}
            </>
          ) : (
            <>Only your filter&apos;s alerts show on your Live feed. </>
          )}
          Pick which models with the switches on the{" "}
          <button type="button" className="link" onClick={() => goTo("model")}>
            Models tab
          </button>
          .
        </p>
      </div>
      <div className="tab-option">
        <button
          type="button"
          role="switch"
          aria-checked={bothOn}
          className={`switch${bothOn ? " on" : ""}`}
          // Switching off always works; switching on needs a model and a filter to agree.
          disabled={!lb || toggling !== null || board.stale || (!bothOn && bothBlocked !== null)}
          onClick={() => void toggle("both")}
        >
          <span className="switch-track">
            <span className="switch-thumb" />
          </span>
          Only alerts both caught
        </button>
        <p className="muted small">
          {bothBlocked === "models" ? (
            <>
              Turn on Model alerts to use this: it keeps only the tokens one of your models and one of your
              filters both alerted on.
              {bothOn && " It's saved as on and applies once Model alerts is back on."}
            </>
          ) : bothBlocked === "filters" ? (
            <>
              Switch on a filter on the{" "}
              <button type="button" className="link" onClick={() => goTo("filters")}>
                Filters tab
              </button>{" "}
              to use this: it keeps only the tokens one of your models and one of your filters both alerted
              on.
            </>
          ) : bothOn ? (
            <>
              Your Live feed and its Stats show only tokens one of your active filters alerted on that one of
              your models also flagged within 6 hours, one card each. Tokens only one side caught are left
              out.
            </>
          ) : (
            <>
              Off: your Live feed shows everything either side caught. Turn on to keep only the tokens one of
              your models and one of your active filters both alerted on.
            </>
          )}
        </p>
        {error && <small className="error">Couldn&apos;t save your feed setting: {error}</small>}
      </div>
    </section>
  );
}
