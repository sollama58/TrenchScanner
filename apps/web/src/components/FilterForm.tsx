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
  maxDevWalletPct: string;
  maxRiskScore: string;
  excludeCriticalRiskFlags: boolean;
  minTokenAgeMinutes: string;
  maxTokenAgeMinutes: string;
  narrativeKeywords: string;
  minScore: string;
  maxFreshTop10WalletPct: string;
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
    maxDevWalletPct: filter?.maxDevWalletPct?.toString() ?? "",
    maxRiskScore: filter?.maxRiskScore?.toString() ?? "",
    excludeCriticalRiskFlags: filter?.excludeCriticalRiskFlags ?? false,
    minTokenAgeMinutes: filter?.minTokenAgeMinutes?.toString() ?? "",
    maxTokenAgeMinutes: filter?.maxTokenAgeMinutes?.toString() ?? "",
    narrativeKeywords: filter?.narrativeKeywords?.join(", ") ?? "",
    minScore: filter?.minScore?.toString() ?? "",
    maxFreshTop10WalletPct: filter?.maxFreshTop10WalletPct?.toString() ?? "",
    isActive: filter?.isActive ?? true,
  };
}

function toNumberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** A small "ⓘ" next to a label, with the explanation as a native hover tooltip. Used for the
 *  RugCheck-derived criteria below, since none of these are self-explanatory from the field name
 *  alone - what "counts" as a critical risk flag, how risk score is computed, etc. */
function Hint({ text }: { text: string }) {
  return (
    <span className="filter-form__hint" title={text}>
      ⓘ
    </span>
  );
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
        maxDevWalletPct: toNumberOrNull(form.maxDevWalletPct),
        maxRiskScore: toNumberOrNull(form.maxRiskScore),
        excludeCriticalRiskFlags: form.excludeCriticalRiskFlags,
        minTokenAgeMinutes: toNumberOrNull(form.minTokenAgeMinutes),
        maxTokenAgeMinutes: toNumberOrNull(form.maxTokenAgeMinutes),
        narrativeKeywords: form.narrativeKeywords
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean),
        minScore: toNumberOrNull(form.minScore),
        maxFreshTop10WalletPct: toNumberOrNull(form.maxFreshTop10WalletPct),
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
        <label>
          <span className="filter-form__label-row">
            Max fresh top-10 wallets %
            <Hint text="% of the top-10 holders whose wallet was first funded less than 24 hours ago - a cluster of brand-new wallets among the top holders often means insiders or a sniper bot loaded up right at launch, not organic buyers. Leave blank to not check this. Unknown for a token RugCheck has not indexed a holder list for." />
          </span>
          <input
            type="number"
            min={0}
            max={100}
            placeholder="e.g. 30"
            value={form.maxFreshTop10WalletPct}
            onChange={(e) => update("maxFreshTop10WalletPct", e.target.value)}
          />
        </label>
      </div>

      <p className="filter-form__section-label">
        RugCheck-derived signals
        <Hint text="These four used to be a mandatory pass/fail check applied to every token before anyone could see it. They're opt-in now, since different users legitimately want different risk tolerances here - unlike mint/freeze authority and LP lock, which still are and always will be mandatory. Leaving one blank/unchecked means it isn't checked at all, not that it's assumed safe." />
      </p>

      <div className="filter-form__row">
        <label>
          <span className="filter-form__label-row">
            Max top-10 holder %
            <Hint text="What % of total supply the top 10 wallets hold combined, excluding the liquidity pool itself. Higher concentration means a small number of wallets can crash the price by selling. RugCheck computes this from on-chain holder balances." />
          </span>
          <input
            type="number"
            min={0}
            max={100}
            placeholder="e.g. 40"
            value={form.maxTop10HolderPct}
            onChange={(e) => update("maxTop10HolderPct", e.target.value)}
          />
        </label>
        <label>
          <span className="filter-form__label-row">
            Max dev wallet %
            <Hint text="What % of supply the token's creator personally holds, if they rank among the top 10 holders. Left blank/unset here rather than treated as 0% when the creator holds too little to rank - that's the common, benign case, not a red flag." />
          </span>
          <input
            type="number"
            min={0}
            max={100}
            placeholder="e.g. 15"
            value={form.maxDevWalletPct}
            onChange={(e) => update("maxDevWalletPct", e.target.value)}
          />
        </label>
      </div>

      <div className="filter-form__row">
        <label>
          <span className="filter-form__label-row">
            Max RugCheck risk score
            <Hint text="RugCheck's own composite score (0-100, higher = riskier), combining signals beyond what we check ourselves - things like insider wallet clustering and bundled buys at launch. Not the same number as this app's own 0-100 score above, which measures breakout potential, not risk." />
          </span>
          <input
            type="number"
            min={0}
            max={100}
            placeholder="e.g. 70"
            value={form.maxRiskScore}
            onChange={(e) => update("maxRiskScore", e.target.value)}
          />
        </label>
        <label className="filter-form__checkbox">
          <input
            type="checkbox"
            checked={form.excludeCriticalRiskFlags}
            onChange={(e) => update("excludeCriticalRiskFlags", e.target.checked)}
          />
          Exclude critical risk flags
          <Hint text="Excludes any token where RugCheck flags the specific creator wallet as either having a documented history of rugging previous tokens, or where the creator identity cannot be determined at all. These are the two flags severe enough that this app used to reject them automatically for everyone." />
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
