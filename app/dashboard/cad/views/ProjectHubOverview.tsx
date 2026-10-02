"use client";

// Marketr — CAD + Hardware slice 4: project hub overview.
// The per-project rollup from GET /api/cad/projects/[id]/dashboard:
// open task/issue counts, low-stock parts (BOM-relevant only), active BOM
// costs, latest revisions, and recent activity. Every figure comes from
// real rows — no estimates invented here.

import { useCallback, useEffect, useState } from "react";
import { ErrorNote, LoadingNote, StatusPill, money } from "./ProjectHubTab";

interface Dashboard {
  project: { id: string; name: string; description: string | null };
  counts: {
    openTasks: number;
    openIssues: number;
    blocked: number;
    done: number;
    total: number;
    models: number;
  };
  lowStockParts: {
    id: string;
    name: string;
    sku: string | null;
    onHandQty: number;
    reorderPoint: number;
    unitOfMeasure: string;
  }[];
  bomCosts: {
    modelId: string;
    modelName: string;
    bomVersionId: string | null;
    bomNumber: number | null;
    knownCostUsd: number | null;
    linesMissingCost: number;
    basis: string;
  }[];
  projectKnownCostUsd: number;
  latestVersions: {
    modelId: string;
    modelName: string;
    versionId: string;
    versionNumber: number;
    format: string;
    uploadedAt: string;
  }[];
  recentActivity: {
    type: "task" | "stock";
    at: string;
    author: string;
    text: string;
    refId: string;
  }[];
}

export function ProjectHubOverview({ projectId }: { projectId: string }) {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/cad/projects/${projectId}/dashboard`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? "Could not load the dashboard.");
      setDashboard(body.dashboard as Dashboard);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the dashboard.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <LoadingNote label="Loading the project rollup" />;
  if (error || !dashboard) return <ErrorNote message={error ?? "Could not load the dashboard."} />;

  const metrics: { label: string; value: string }[] = [
    { label: "Open tasks", value: String(dashboard.counts.openTasks) },
    { label: "Open issues", value: String(dashboard.counts.openIssues) },
    { label: "Blocked", value: String(dashboard.counts.blocked) },
    { label: "Done", value: String(dashboard.counts.done) },
    { label: "Models", value: String(dashboard.counts.models) },
    { label: "Known cost (all BOMs)", value: money(dashboard.projectKnownCostUsd) },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        {metrics.map((m) => (
          <div
            key={m.label}
            className="rounded-lg border border-line bg-paper p-3 shadow-hairline"
          >
            <p className="text-2xl font-semibold text-ink">{m.value}</p>
            <p className="mt-0.5 text-xs text-muted">{m.label}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section
          className="rounded-lg border border-line bg-paper p-4 shadow-hairline"
          aria-label="Low-stock parts"
        >
          <h3 className="mb-1 text-sm font-semibold text-ink">Low-stock parts</h3>
          <p className="mb-3 text-xs text-muted">
            Parts on this project's BOMs that are at or below their reorder
            point. Parts not on the project's BOMs are not shown here.
          </p>
          {dashboard.lowStockParts.length === 0 ? (
            <p className="text-sm text-muted">
              No low-stock parts on this project's BOMs.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs font-semibold text-muted">
                  <th className="py-2 pr-2">Part</th>
                  <th className="py-2 pr-2">On hand</th>
                  <th className="py-2">Reorder point</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.lowStockParts.map((p) => (
                  <tr key={p.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className="py-2 pr-2">
                      <span className="font-medium text-ink">{p.name}</span>
                      {p.sku && <span className="ml-2 font-mono text-xs text-muted">{p.sku}</span>}
                    </td>
                    <td className="py-2 pr-2">
                      <span className="font-mono text-xs text-ink">
                        {p.onHandQty} {p.unitOfMeasure}
                      </span>{" "}
                      <StatusPill>Low stock</StatusPill>
                    </td>
                    <td className="py-2 font-mono text-xs text-muted">{p.reorderPoint}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section
          className="rounded-lg border border-line bg-paper p-4 shadow-hairline"
          aria-label="Active BOM costs"
        >
          <h3 className="mb-1 text-sm font-semibold text-ink">Active BOM costs</h3>
          <p className="mb-3 text-xs text-muted">
            The latest BOM per model. Costs with no quoted figure contribute
            $0 and are counted — the known cost is a lower bound.
          </p>
          {dashboard.bomCosts.length === 0 ? (
            <p className="text-sm text-muted">No models yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs font-semibold text-muted">
                  <th className="py-2 pr-2">Model</th>
                  <th className="py-2 pr-2">Known cost</th>
                  <th className="py-2">Unknown lines</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.bomCosts.map((b) => (
                  <tr key={b.modelId} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className="py-2 pr-2">
                      <span className="font-medium text-ink">{b.modelName}</span>
                      <span className="ml-2 font-mono text-xs text-muted">
                        {b.bomNumber != null ? `BOM #${b.bomNumber}` : "no BOM"}
                      </span>
                    </td>
                    <td className="py-2 pr-2 font-mono text-xs text-ink">
                      {b.knownCostUsd != null ? money(b.knownCostUsd) : "—"}
                    </td>
                    <td className="py-2 font-mono text-xs text-muted">
                      {b.bomVersionId ? b.linesMissingCost : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section
          className="rounded-lg border border-line bg-paper p-4 shadow-hairline"
          aria-label="Latest revisions"
        >
          <h3 className="mb-3 text-sm font-semibold text-ink">Latest revisions</h3>
          {dashboard.latestVersions.length === 0 ? (
            <p className="text-sm text-muted">No models yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs font-semibold text-muted">
                  <th className="py-2 pr-2">Model</th>
                  <th className="py-2 pr-2">Version</th>
                  <th className="py-2">Uploaded</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.latestVersions.map((v) => (
                  <tr key={v.versionId} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className="py-2 pr-2 font-medium text-ink">{v.modelName}</td>
                    <td className="py-2 pr-2">
                      <span className="rounded-full bg-canvas px-2.5 py-1 font-mono text-xs font-semibold text-ink">
                        v{v.versionNumber}
                      </span>{" "}
                      <span className="font-mono text-xs text-muted">{v.format.toUpperCase()}</span>
                    </td>
                    <td className="py-2 font-mono text-xs text-muted">
                      {new Date(v.uploadedAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section
          className="rounded-lg border border-line bg-paper p-4 shadow-hairline"
          aria-label="Recent activity"
        >
          <h3 className="mb-3 text-sm font-semibold text-ink">Recent activity</h3>
          {dashboard.recentActivity.length === 0 ? (
            <p className="text-sm text-muted">No activity yet.</p>
          ) : (
            <ul className="space-y-2.5">
              {dashboard.recentActivity.map((a, i) => (
                <li key={`${a.refId}-${i}`} className="text-sm">
                  <p className="text-ink">{a.text}</p>
                  <p className="mt-0.5 font-mono text-xs text-muted">
                    {a.author} · {new Date(a.at).toLocaleString()}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
