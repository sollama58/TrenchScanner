import { useEffect, useState } from "react";
import { createFilter, deleteFilter, listFilters, updateFilter } from "../api/client";
import type { FilterInput, UserFilter } from "../api/types";
import { FilterForm } from "../components/FilterForm";

export function Filters() {
  const [filters, setFilters] = useState<UserFilter[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | "new" | null>(null);

  const refresh = () => listFilters().then(setFilters);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, []);

  const handleCreate = async (input: Partial<FilterInput>) => {
    await createFilter(input);
    setEditingId(null);
    await refresh();
  };

  const handleUpdate = async (id: string, input: Partial<FilterInput>) => {
    await updateFilter(id, input);
    setEditingId(null);
    await refresh();
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this filter? You'll stop getting matches for it.")) return;
    await deleteFilter(id);
    await refresh();
  };

  const handleToggleActive = async (filter: UserFilter) => {
    await updateFilter(filter.id, { isActive: !filter.isActive });
    await refresh();
  };

  if (loading) return <p className="empty-state">Loading filters…</p>;

  return (
    <div className="filters-page">
      <div className="dashboard__header">
        <h2>Filters</h2>
        {editingId === null && (
          <button className="btn btn--primary" onClick={() => setEditingId("new")}>
            + New filter
          </button>
        )}
      </div>

      {editingId === "new" && (
        <div className="filter-card filter-card--editing">
          <FilterForm onSave={handleCreate} onCancel={() => setEditingId(null)} />
        </div>
      )}

      {filters.length === 0 && editingId === null && (
        <p className="empty-state">
          No filters yet. The platform scans the $50k-$500k market cap band by default - create a filter to
          start matching tokens against your own criteria.
        </p>
      )}

      <div className="filter-list">
        {filters.map((filter) =>
          editingId === filter.id ? (
            <div key={filter.id} className="filter-card filter-card--editing">
              <FilterForm
                initial={filter}
                onSave={(input) => handleUpdate(filter.id, input)}
                onCancel={() => setEditingId(null)}
              />
            </div>
          ) : (
            <div key={filter.id} className="filter-card">
              <div className="filter-card__header">
                <h3>{filter.name}</h3>
                <span className={`badge ${filter.isActive ? "badge--on" : "badge--off"}`}>
                  {filter.isActive ? "Active" : "Paused"}
                </span>
              </div>
              <p className="filter-card__summary">
                ${filter.mcapMin.toLocaleString()} – ${filter.mcapMax.toLocaleString()} mcap
                {filter.minScore != null && ` · min score ${filter.minScore}`}
                {filter.narrativeKeywords.length > 0 && ` · keywords: ${filter.narrativeKeywords.join(", ")}`}
              </p>
              <div className="filter-card__actions">
                <button className="btn" onClick={() => setEditingId(filter.id)}>
                  Edit
                </button>
                <button className="btn" onClick={() => void handleToggleActive(filter)}>
                  {filter.isActive ? "Pause" : "Resume"}
                </button>
                <button className="btn btn--danger" onClick={() => void handleDelete(filter.id)}>
                  Delete
                </button>
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
