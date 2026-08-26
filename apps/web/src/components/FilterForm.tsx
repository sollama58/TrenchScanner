import { useState, type FormEvent } from "react";
import type { FilterInput, UserFilter } from "../api/types";

interface FilterFormProps {
  initial?: UserFilter;
  onSave: (input: Partial<FilterInput>) => Promise<void>;
  onCancel?: () => void;
}

interface FormState {
  name: string;
  mcapMin: string;
  mcapMax: string;
  minVolumeMcapRatio: string;
  minHolderGrowthPct: string;
  maxTop10HolderPct: string;
  minTokenAgeMinutes: string;
  maxTokenAgeMinutes: string;
  narrativeKeywords: string;
  minScore: string;
  isActive: boolean;
}

function toFormState(filter?: UserFilter): FormState {
  return {
    name: filter?.name ?? "New filter",
    mcapMin: String(filter?.mcapMin ?? 50_000),
    mcapMax: String(filter?.mcapMax ?? 500_000),
    minVolumeMcapRatio: filter?.minVolumeMcapRatio?.toString() ?? "",
    minHolderGrowthPct: filter?.minHolderGrowthPct?.toString() ?? "",
    maxTop10HolderPct: filter?.maxTop10HolderPct?.toString() ?? "",
    minTokenAgeMinutes: filter?.minTokenAgeMinutes?.toString() ?? "",
    maxTokenAgeMinutes: filter?.maxTokenAgeMinutes?.toString() ?? "",
    narrativeKeywords: filter?.narrativeKeywords?.join(", ") ?? "",
    minScore: filter?.minScore?.toString() ?? "",
    isActive: filter?.isActive ?? true,
  };
}

function toNumberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export function FilterForm({ initial, onSave, onCancel }: FilterFormProps) {
  const [form, setForm] = useState<FormState>(() => toFormState(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    const mcapMin = Number(form.mcapMin);
    const mcapMax = Number(form.mcapMax);
    if (!Number.isFinite(mcapMin) || !Number.isFinite(mcapMax) || mcapMin >= mcapMax) {
      setError("Min market cap must be a number less than max market cap.");
      return;
    }

    setSaving(true);
    try {
      await onSave({
        name: form.name.trim() || "Untitled filter",
        mcapMin,
        mcapMax,
        minVolumeMcapRatio: toNumberOrNull(form.minVolumeMcapRatio),
        minHolderGrowthPct: toNumberOrNull(form.minHolderGrowthPct),
        maxTop10HolderPct: toNumberOrNull(form.maxTop10HolderPct),
        minTokenAgeMinutes: toNumberOrNull(form.minTokenAgeMinutes),
        maxTokenAgeMinutes: toNumberOrNull(form.maxTokenAgeMinutes),
        narrativeKeywords: form.narrativeKeywords
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean),
        minScore: toNumberOrNull(form.minScore),
        isActive: form.isActive,
      });
    } catch {
      setError("Couldn't save this filter. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="filter-form" onSubmit={handleSubmit}>
      <div className="filter-form__row">
        <label>
          Filter name
          <input value={form.name} onChange={(e) => update("name", e.target.value)} required />
        </label>
        <label className="filter-form__checkbox">
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={(e) => update("isActive", e.target.checked)}
          />
          Active
        </label>
      </div>

      <div className="filter-form__row">
        <label>
          Min market cap ($)
          <input
            type="number"
            min={0}
            value={form.mcapMin}
            onChange={(e) => update("mcapMin", e.target.value)}
            required
          />
        </label>
        <label>
          Max market cap ($)
          <input
            type="number"
            min={0}
            value={form.mcapMax}
            onChange={(e) => update("mcapMax", e.target.value)}
            required
          />
        </label>
      </div>

      <div className="filter-form__row">
        <label>
          Min volume/mcap ratio
          <input
            type="number"
            step="0.1"
            placeholder="e.g. 0.5"
            value={form.minVolumeMcapRatio}
            onChange={(e) => update("minVolumeMcapRatio", e.target.value)}
          />
        </label>
        <label>
          Min holder growth %
          <input
            type="number"
            placeholder="e.g. 10"
            value={form.minHolderGrowthPct}
            onChange={(e) => update("minHolderGrowthPct", e.target.value)}
          />
        </label>
      </div>

      <div className="filter-form__row">
        <label>
          Max top-10 holder %
          <input
            type="number"
            placeholder="e.g. 40"
            value={form.maxTop10HolderPct}
            onChange={(e) => update("maxTop10HolderPct", e.target.value)}
          />
        </label>
        <label>
          Min score (0-100)
          <input
            type="number"
            min={0}
            max={100}
            placeholder="e.g. 60"
            value={form.minScore}
            onChange={(e) => update("minScore", e.target.value)}
          />
        </label>
      </div>

      <div className="filter-form__row">
        <label>
          Min age (minutes)
          <input
            type="number"
            min={0}
            placeholder="e.g. 30"
            value={form.minTokenAgeMinutes}
            onChange={(e) => update("minTokenAgeMinutes", e.target.value)}
          />
        </label>
        <label>
          Max age (minutes)
          <input
            type="number"
            min={0}
            placeholder="e.g. 2880"
            value={form.maxTokenAgeMinutes}
            onChange={(e) => update("maxTokenAgeMinutes", e.target.value)}
          />
        </label>
      </div>

      <label>
        Narrative keywords (comma-separated, optional)
        <input
          placeholder="e.g. dog, ai, trump"
          value={form.narrativeKeywords}
          onChange={(e) => update("narrativeKeywords", e.target.value)}
        />
      </label>

      {error && <p className="form-error">{error}</p>}

      <div className="filter-form__actions">
        <button type="submit" className="btn btn--primary" disabled={saving}>
          {saving ? "Saving…" : "Save filter"}
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
