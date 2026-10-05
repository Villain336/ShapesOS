"use client";

// Marketr — standalone keyword research task widget (keyword_research, 40 credits).
// Mounted on the Keyword Research page below the ideas flow. Shows the credit
// cost before running and surfaces cap-denial messages verbatim.

import { useState, type FormEvent } from "react";
import type { KeywordResearchReport } from "@/lib/keywords/research";

const inputCls =
  "rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]";

const CLUSTER_LABELS: Record<string, string> = {
  informational: "Informational",
  navigational: "Navigational",
  commercial: "Commercial",
  transactional: "Transactional",
  unknown: "Unknown intent",
};

function fmt(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US");
}

export default function KeywordResearchTask({
  projectId,
}: {
  projectId: string;
}) {
  const [seed, setSeed] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<KeywordResearchReport | null>(null);

  async function onResearch(e: FormEvent) {
    e.preventDefault();
    if (!seed.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/keywords/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, seedKeyword: seed.trim() }),
      });
      const json = await res.json();
      if (!res.ok) {
        // Cap-denial and validation messages are surfaced verbatim.
        setError(json.error ?? "Research failed.");
        return;
      }
      setReport(json.report as KeywordResearchReport);
    } catch {
      setError("Network error. Is the app server running?");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg bg-paper p-5 shadow-hairline">
      <div>
        <h2 className="text-sm font-semibold text-muted">
          Full research task
        </h2>
        <p className="mt-1 text-sm text-muted">
          Seed metrics plus a clustered ideas report (volumes, difficulty, CPC,
          intent). <span className="font-medium text-ink">Costs 40 credits</span>{" "}
          per task (same seed, same day is not charged twice).
        </p>
      </div>
      <form onSubmit={onResearch} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label
            htmlFor="research-seed"
            className="mb-1 block text-xs font-semibold text-muted"
          >
            Seed keyword
          </label>
          <input
            id="research-seed"
            placeholder="e.g. senior living"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            maxLength={200}
            className={`w-full ${inputCls}`}
          />
        </div>
        <button
          type="submit"
          disabled={loading || !seed.trim()}
          className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white aos-press disabled:bg-disabled disabled:text-disabled-fg"
        >
          {loading ? "Researching…" : "Run research task"}
        </button>
      </form>
      {error && <p className="text-sm text-failed-text">{error}</p>}
      {report && (
        <div className="flex flex-col gap-4">
          {report.mock && (
            <p className="text-xs text-muted">
              Mock keyword data — connect a live data source for real volumes.
            </p>
          )}
          <div className="rounded-md border border-line bg-paper p-4 text-sm">
            <div className="text-xs font-semibold text-muted">
              Seed: {report.seed}
            </div>
            {report.seedMetrics ? (
              <div className="mt-2 flex flex-wrap gap-4">
                <span><span className="text-muted">Volume:</span> <span className="font-medium">{fmt(report.seedMetrics.volume)}</span></span>
                <span><span className="text-muted">Difficulty:</span> <span className="font-medium">{report.seedMetrics.difficulty ?? "—"}</span></span>
                <span><span className="text-muted">CPC:</span> <span className="font-medium">{report.seedMetrics.cpc != null ? `$${report.seedMetrics.cpc.toFixed(2)}` : "—"}</span></span>
                <span><span className="text-muted">Intent:</span> <span className="font-medium">{report.seedMetrics.intent}</span></span>
              </div>
            ) : (
              <p className="mt-2 text-muted">{report.seedMetricsNote}</p>
            )}
          </div>
          {Object.entries(report.clusters).map(([intent, ideas]) =>
            ideas.length > 0 ? (
              <div key={intent}>
                <h3 className="text-xs font-semibold text-muted">
                  {CLUSTER_LABELS[intent] ?? intent} ({ideas.length})
                </h3>
                <table className="mt-1 w-full text-sm">
                  <tbody>
                    {ideas.slice(0, 10).map((idea) => (
                      <tr key={idea.phrase} className="border-t border-line">
                        <td className="py-2 pr-4">{idea.phrase}</td>
                        <td className="py-2 pr-4 text-muted">vol {fmt(idea.volume)}</td>
                        <td className="py-2 text-muted">diff {idea.difficulty ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {ideas.length > 10 && (
                  <p className="mt-1 text-xs text-muted">
                    +{ideas.length - 10} more in this cluster
                  </p>
                )}
              </div>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}
