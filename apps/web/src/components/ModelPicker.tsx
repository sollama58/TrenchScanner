import { useState } from "react";
import { put, type Leaderboard } from "../api";
import { invalidate } from "../cache";

/**
 * Picks whose calls the Curated feed shows. Names and order come straight from the leaderboard,
 * so a model is called the same thing here as on the Model tab. "Default" follows whichever model
 * the system defaults to (the consensus once it can call), and keeps following it.
 */
export function ModelPicker({ board, onChanged }: { board: Leaderboard; onChanged: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const defaultName = board.entries.find((e) => e.id === board.defaultModel)?.name ?? board.defaultModel;

  const choose = async (value: string) => {
    setSaving(true);
    setError(null);
    try {
      await put("/curated/model", { model: value === "" ? null : value });
      // Every cached /curated* answer was for the old pick.
      invalidate("/curated");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <label className="model-picker">
      <span className="eyebrow">Model</span>
      <select
        value={board.followsDefault ? "" : board.selectedModel}
        disabled={saving}
        onChange={(e) => void choose(e.target.value)}
        aria-label="Whose calls to show"
      >
        <option value="">Default · {defaultName}</option>
        {board.entries.map((e) => (
          <option key={e.id} value={e.id}>
            #{e.rank} {e.name}
            {e.composite.score === null ? "" : ` · ${e.composite.score.toFixed(0)}`}
          </option>
        ))}
      </select>
      {error && <small className="error">{error}</small>}
    </label>
  );
}
