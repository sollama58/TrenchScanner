import { useState } from "react";
import type { Leaderboard } from "../api";
import { BrainIcon } from "./Icons";
import { saveFeedSettings } from "./ModelPicker";
import { usePolling } from "../hooks";

/**
 * Settings › Your feed: the Model alerts switch, whether the models' calls join your filter's
 * alerts on the Live feed (user decision 2026-10-15). The feed's numbers are the Live feed's Stats
 * button; which models' calls you get is picked on the Models tab.
 */
export function FeedPanel({ goTo }: { goTo: (tab: "model") => void }) {
  // Bumped when the switch changes, so the board refetches at once.
  const [pick, setPick] = useState(0);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const board = usePolling<Leaderboard>("/curated/models?days=30", 120_000, String(pick));
  const lb = board.data;
  const modelsOn = lb?.showModelAlerts ?? true;
  const chosen = lb ? lb.entries.filter((e) => lb.selectedModels.includes(e.id)).map((e) => e.name) : [];

  const toggleModels = async () => {
    setToggling(true);
    setError(null);
    try {
      await saveFeedSettings({ showModelAlerts: !modelsOn });
      setPick((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setToggling(false);
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
          disabled={!lb || toggling || board.stale}
          onClick={() => void toggleModels()}
        >
          <span className="switch-track">
            <span className="switch-thumb" />
          </span>
          Model alerts
        </button>
        <p className="muted small">
          {modelsOn ? (
            <>
              The models&apos; calls ({chosen.join(", ") || "–"}) show on your Live feed beside your
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
        {error && <small className="error">Couldn&apos;t switch model alerts: {error}</small>}
      </div>
    </section>
  );
}
