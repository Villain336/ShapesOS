"use client";

// Marketr — competitor keyword-gap analysis (spec §5 flow 2, §7 item 4):
// add competitor domains → fetch their ranked keywords via the provider →
// diff against the project's saved keywords → save gaps to a list.

import { useEffect, useState, type FormEvent } from "react";
import type { CompetitorKeyword } from "@/lib/providers/types";
import { confirmAction } from "@/lib/ui/feedback";

type Competitor = {
  id: string;
  domain: string;
  addedAt: string;
};

type Gap = CompetitorKeyword & { opportunity: number };

const th =
  "px-3 py-2 text-left text-xs font-medium text-muted";
const td = "px-3 py-2 text-sm";
const inputCls =
  "rounded-md border border-control bg-paper px-3 py-2 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none";

function fmt(n: number | null, digits = 0): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export default function CompetitorGap({ projectId }: { projectId: string }) {
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [newDomain, setNewDomain] = useState("");
  const [adding, setAdding] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [provider, setProvider] = useState<{
    name: string;
    isLive: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [listName, setListName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  async function loadCompetitors() {
    const res = await fetch(
      `/api/competitors?projectId=${encodeURIComponent(projectId)}`,
    );
    if (res.ok) {
      const json = await res.json();
      setCompetitors(json.competitors ?? []);
    }
  }

  useEffect(() => {
    loadCompetitors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    if (!newDomain.trim()) return;
    setAdding(true);
    setError(null);
    try {
      const res = await fetch("/api/competitors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, domain: newDomain.trim() }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Could not add competitor.");
        return;
      }
      setNewDomain("");
      await loadCompetitors();
      setSelectedId(json.competitor.id);
      await analyzeGap(json.competitor.id);
    } finally {
      setAdding(false);
    }
  }

  async function onRemove(id: string) {
    const ok = await confirmAction({
      title: "Remove this competitor?",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    const res = await fetch(`/api/competitors/${id}`, { method: "DELETE" });
    if (res.ok) {
      await loadCompetitors();
      if (selectedId === id) {
        setSelectedId(null);
        setGaps([]);
        setProvider(null);
      }
    }
  }

  async function analyzeGap(id: string) {
    setSelectedId(id);
    setLoading(true);
    setError(null);
    setSaveMsg(null);
    setGaps([]);
    try {
      const res = await fetch("/api/competitors/gap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, competitorId: id, limit: 50 }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Gap analysis failed.");
        return;
      }
      setGaps(json.gaps ?? []);
      setProvider(json.provider ?? null);
      setSelected(new Set());
    } catch {
      setError("Network error. Is the app server running?");
    } finally {
      setLoading(false);
    }
  }

  function toggleSelect(phrase: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(phrase)) next.delete(phrase);
      else next.add(phrase);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === gaps.length ? new Set() : new Set(gaps.map((g) => g.phrase)),
    );
  }

  async function onSave() {
    const toSave = gaps.filter((g) => selected.has(g.phrase));
    if (toSave.length === 0) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch("/api/keywords/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          list: listName.trim() || undefined,
          ideas: toSave,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setSaveMsg(`Save failed: ${json.error ?? "unknown error"}`);
        return;
      }
      setSaveMsg(`Saved ${json.saved} keyword(s) to “${json.list}”.`);
      setSelected(new Set());
    } finally {
      setSaving(false);
    }
  }

  const selectedCompetitor = competitors.find((c) => c.id === selectedId);

  return (
    <div className="flex flex-col gap-8">
      {/* Provider banner */}
      {provider && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            provider.isLive
              ? "border-line bg-paper text-muted"
              : "border-line bg-canvas text-ink"
          }`}
        >
          {provider.isLive ? (
            <>Live data from DataForSEO.</>
          ) : (
            <>
              Showing <strong>mock data</strong> — add{" "}
              <span className="font-mono">DATAFORSEO_LOGIN</span> and{" "}
              <span className="font-mono">DATAFORSEO_PASSWORD</span> to{" "}
              <span className="font-mono">.env</span> for live competitor data.
            </>
          )}
        </div>
      )}

      {/* Add competitor */}
      <form
        onSubmit={onAdd}
        className="flex flex-col gap-3 rounded-lg bg-paper shadow-hairline p-5 sm:flex-row sm:items-end"
      >
        <div className="flex-1">
          <label
            htmlFor="domain"
            className="mb-1 block text-xs font-medium text-muted"
          >
            Competitor domain
          </label>
          <input
            id="domain"
            placeholder="e.g. competitor.com"
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            className={`w-full ${inputCls}`}
          />
        </div>
        <button
          type="submit"
          disabled={adding}
          className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white hover:bg-night-hover disabled:opacity-50 aos-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {adding ? "Adding…" : "Add competitor"}
        </button>
      </form>
      {error && <p className="text-sm text-failed-text">{error}</p>}

      {/* Competitor list */}
      <div>
        <h2 className="mb-3 text-sm font-medium text-muted">
          Competitors ({competitors.length})
        </h2>
        {competitors.length === 0 ? (
          <p className="rounded-lg border border-dashed border-control p-6 text-center text-sm text-muted">
            No competitors yet. Add one above to analyze the keyword gap.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {competitors.map((c) => (
              <li
                key={c.id}
                className={`flex items-center justify-between rounded-md border px-5 py-3 ${
                  selectedId === c.id
                    ? "border-ink bg-paper"
                    : "border-line bg-paper"
                }`}
              >
                <button
                  onClick={() => analyzeGap(c.id)}
                  className="text-left font-medium text-ink hover:underline"
                >
                  {c.domain}
                </button>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => analyzeGap(c.id)}
                    disabled={loading && selectedId === c.id}
                    className="rounded-full bg-paper px-2.5 py-1 text-xs font-semibold text-ink shadow-control hover:shadow-outline disabled:opacity-50"
                  >
                    {loading && selectedId === c.id
                      ? "Analyzing…"
                      : "Analyze gap"}
                  </button>
                  <button
                    onClick={() => onRemove(c.id)}
                    className="rounded-full px-2 py-1 text-xs font-semibold text-failed-text hover:bg-failed-tint"
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Gap results */}
      {selectedCompetitor && (
        <div className="flex flex-col gap-4">
          <h2 className="text-sm font-medium text-muted">
            Keyword gaps — {selectedCompetitor.domain}
            {gaps.length > 0 && (
              <span className="ml-2 normal-case tracking-normal text-muted">
                {gaps.length} keyword{gaps.length === 1 ? "" : "s"} they rank
                for that you don’t have, sorted by opportunity
              </span>
            )}
          </h2>

          {!loading && gaps.length === 0 && provider && (
            <p className="rounded-lg border border-dashed border-control p-6 text-center text-sm text-muted">
              No gaps found — you already cover every keyword this competitor
              ranks for in the analyzed set.
            </p>
          )}

          {gaps.length > 0 && (
            <>
              <div className="overflow-x-auto rounded-lg border border-line bg-paper">
                <table className="w-full border-collapse">
                  <thead className="bg-paper">
                    <tr>
                      <th className={th}>
                        <input
                          type="checkbox"
                          checked={
                            gaps.length > 0 && selected.size === gaps.length
                          }
                          onChange={toggleAll}
                          aria-label="Select all"
                        />
                      </th>
                      <th className={th}>Keyword</th>
                      <th className={th}>Their pos.</th>
                      <th className={th}>Ranking URL</th>
                      <th className={th}>Volume</th>
                      <th className={th}>Difficulty</th>
                      <th className={th}>CPC</th>
                      <th className={th}>Intent</th>
                      <th className={th}>Opportunity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gaps.map((g) => (
                      <tr
                        key={g.phrase}
                        className="border-t border-line hover:bg-hover-paper"
                      >
                        <td className={td}>
                          <input
                            type="checkbox"
                            checked={selected.has(g.phrase)}
                            onChange={() => toggleSelect(g.phrase)}
                            aria-label={`Select ${g.phrase}`}
                          />
                        </td>
                        <td className={`${td} font-medium text-ink`}>
                          {g.phrase}
                          {g.mock && (
                            <span className="ml-2 rounded-full bg-canvas px-1.5 py-0.5 text-[10px] font-semibold text-muted">
                              mock
                            </span>
                          )}
                        </td>
                        <td className={td}>
                          {g.position == null ? "—" : `#${g.position}`}
                        </td>
                        <td className={`${td} max-w-48`}>
                          {g.url ? (
                            <a
                              href={g.url}
                              target="_blank"
                              rel="noreferrer"
                              title={g.url}
                              className="block truncate text-muted hover:text-ink hover:underline"
                            >
                              {g.url}
                            </a>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className={td}>{fmt(g.volume)}</td>
                        <td className={td}>{fmt(g.difficulty)}</td>
                        <td className={td}>
                          {g.cpc == null ? "—" : `$${fmt(g.cpc, 2)}`}
                        </td>
                        <td className={td}>
                          <span className="rounded-full bg-canvas px-2 py-0.5 text-xs font-semibold text-muted">
                            {g.intent}
                          </span>
                        </td>
                        <td className={`${td} font-semibold text-ink`}>
                          {fmt(g.opportunity)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-col gap-3 rounded-lg bg-paper shadow-hairline p-4 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <label
                    htmlFor="gap-list"
                    className="mb-1 block text-xs font-medium text-muted"
                  >
                    Save {selected.size} selected to list
                  </label>
                  <input
                    id="gap-list"
                    placeholder="e.g. Competitor gap — Q4"
                    value={listName}
                    onChange={(e) => setListName(e.target.value)}
                    className={`w-full ${inputCls}`}
                  />
                </div>
                <button
                  onClick={onSave}
                  disabled={saving || selected.size === 0}
                  className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white hover:bg-night-hover disabled:opacity-50 aos-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  {saving ? "Saving…" : `Save ${selected.size} keyword(s)`}
                </button>
              </div>
              {saveMsg && (
                <p className="text-sm text-ink">{saveMsg}</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
