"use client";

// Marketr — keyword research flow (spec §5 flow 1):
// seed keyword → provider ideas (volume, difficulty, CPC, intent) →
// filter → save winners to a named list (persisted to the Keyword table).

import { useEffect, useState, type FormEvent } from "react";
import type { KeywordIdea } from "@/lib/providers/types";

const INTENTS = [
  "informational",
  "navigational",
  "commercial",
  "transactional",
  "unknown",
] as const;

type SavedKeyword = {
  id: string;
  phrase: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  intent: string;
  list: string | null;
};

const th =
  "px-3 py-2 text-left text-xs font-medium uppercase tracking-widest text-zinc-500";
const td = "px-3 py-2 text-sm";
const inputCls =
  "rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-orange-500 focus:outline-none";

function fmt(n: number | null, digits = 0): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export default function KeywordResearch({ projectId }: { projectId: string }) {
  const [seed, setSeed] = useState("");
  const [maxDifficulty, setMaxDifficulty] = useState(100);
  const [minVolume, setMinVolume] = useState(0);
  const [intentFilter, setIntentFilter] = useState<string[]>([]);
  const [ideas, setIdeas] = useState<KeywordIdea[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [provider, setProvider] = useState<{
    name: string;
    isLive: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listName, setListName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedKeyword[]>([]);

  async function loadSaved() {
    const res = await fetch(
      `/api/keywords/saved?projectId=${encodeURIComponent(projectId)}`,
    );
    if (res.ok) {
      const json = await res.json();
      setSaved(json.keywords ?? []);
    }
  }

  useEffect(() => {
    loadSaved();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function onResearch(e: FormEvent) {
    e.preventDefault();
    if (!seed.trim()) return;
    setLoading(true);
    setError(null);
    setSaveMsg(null);
    try {
      const res = await fetch("/api/keywords/ideas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, seed: seed.trim(), limit: 50 }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Research failed.");
        return;
      }
      setIdeas(json.ideas ?? []);
      setProvider(json.provider ?? null);
      setSelected(new Set());
    } catch {
      setError("Network error. Is the app server running?");
    } finally {
      setLoading(false);
    }
  }

  function toggleIntent(intent: string) {
    setIntentFilter((prev) =>
      prev.includes(intent)
        ? prev.filter((i) => i !== intent)
        : [...prev, intent],
    );
  }

  const filtered = ideas.filter((i) => {
    if (i.difficulty != null && i.difficulty > maxDifficulty) return false;
    if (i.volume != null && i.volume < minVolume) return false;
    if (intentFilter.length > 0 && !intentFilter.includes(i.intent))
      return false;
    return true;
  });

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
      prev.size === filtered.length
        ? new Set()
        : new Set(filtered.map((i) => i.phrase)),
    );
  }

  async function onSave() {
    const toSave = filtered.filter((i) => selected.has(i.phrase));
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
      await loadSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Provider banner */}
      {provider && (
        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            provider.isLive
              ? "border-emerald-200 bg-emerald-50/40 text-emerald-700"
              : "border-amber-200 bg-amber-50/40 text-amber-700"
          }`}
        >
          {provider.isLive ? (
            <>Live data from DataForSEO.</>
          ) : (
            <>
              Showing <strong>mock data</strong> — add{" "}
              <span className="font-mono">DATAFORSEO_LOGIN</span> and{" "}
              <span className="font-mono">DATAFORSEO_PASSWORD</span> to{" "}
              <span className="font-mono">.env</span> for live keyword data.
            </>
          )}
        </div>
      )}

      {/* Research form */}
      <form
        onSubmit={onResearch}
        className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white/60 p-5 sm:flex-row sm:items-end"
      >
        <div className="flex-1">
          <label
            htmlFor="seed"
            className="mb-1 block text-xs font-medium uppercase tracking-widest text-zinc-500"
          >
            Seed keyword
          </label>
          <input
            id="seed"
            placeholder="e.g. senior living"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            className={`w-full ${inputCls}`}
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="rounded-md bg-orange-700 px-4 py-2 text-sm font-medium text-white hover:bg-orange-800 disabled:opacity-50 active:scale-[0.96] transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2"
        >
          {loading ? "Researching…" : "Research"}
        </button>
      </form>
      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* Results */}
      {ideas.length > 0 && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border border-zinc-200 bg-white/60 p-4 text-sm">
            <label className="flex items-center gap-2 text-zinc-500">
              Max difficulty
              <input
                type="number"
                min={0}
                max={100}
                value={maxDifficulty}
                onChange={(e) => setMaxDifficulty(Number(e.target.value))}
                className={`w-20 ${inputCls}`}
              />
            </label>
            <label className="flex items-center gap-2 text-zinc-500">
              Min volume
              <input
                type="number"
                min={0}
                value={minVolume}
                onChange={(e) => setMinVolume(Number(e.target.value))}
                className={`w-24 ${inputCls}`}
              />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-zinc-500">Intent:</span>
              {INTENTS.map((intent) => (
                <button
                  key={intent}
                  type="button"
                  onClick={() => toggleIntent(intent)}
                  className={`rounded-full border px-3 py-1 text-xs ${
                    intentFilter.includes(intent)
                      ? "border-zinc-900 bg-zinc-900 text-white"
                      : "border-zinc-200 text-zinc-500 hover:border-zinc-400"
                  }`}
                >
                  {intent}
                </button>
              ))}
            </div>
            <span className="text-zinc-500">
              {filtered.length} of {ideas.length} ideas
            </span>
          </div>

          <div className="overflow-x-auto rounded-xl border border-zinc-200">
            <table className="w-full border-collapse">
              <thead className="bg-white">
                <tr>
                  <th className={th}>
                    <input
                      type="checkbox"
                      checked={
                        filtered.length > 0 &&
                        selected.size === filtered.length
                      }
                      onChange={toggleAll}
                      aria-label="Select all"
                    />
                  </th>
                  <th className={th}>Keyword</th>
                  <th className={th}>Volume</th>
                  <th className={th}>Difficulty</th>
                  <th className={th}>CPC</th>
                  <th className={th}>Intent</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((idea) => (
                  <tr
                    key={idea.phrase}
                    className="border-t border-zinc-200/60 hover:bg-zinc-100/60"
                  >
                    <td className={td}>
                      <input
                        type="checkbox"
                        checked={selected.has(idea.phrase)}
                        onChange={() => toggleSelect(idea.phrase)}
                        aria-label={`Select ${idea.phrase}`}
                      />
                    </td>
                    <td className={`${td} font-medium text-zinc-900`}>
                      {idea.phrase}
                      {idea.mock && (
                        <span className="ml-2 rounded bg-amber-100/60 px-1.5 py-0.5 text-[10px] uppercase text-amber-700">
                          mock
                        </span>
                      )}
                    </td>
                    <td className={td}>{fmt(idea.volume)}</td>
                    <td className={td}>{fmt(idea.difficulty)}</td>
                    <td className={td}>
                      {idea.cpc == null ? "—" : `$${fmt(idea.cpc, 2)}`}
                    </td>
                    <td className={td}>
                      <span className="rounded-full border border-zinc-200 px-2 py-0.5 text-xs text-zinc-500">
                        {idea.intent}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white/60 p-4 sm:flex-row sm:items-end">
            <div className="flex-1">
              <label
                htmlFor="list"
                className="mb-1 block text-xs font-medium uppercase tracking-widest text-zinc-500"
              >
                Save {selected.size} selected to list
              </label>
              <input
                id="list"
                placeholder="e.g. Q4 content targets"
                value={listName}
                onChange={(e) => setListName(e.target.value)}
                className={`w-full ${inputCls}`}
              />
            </div>
            <button
              onClick={onSave}
              disabled={saving || selected.size === 0}
              className="rounded-md bg-orange-700 px-4 py-2 text-sm font-medium text-white hover:bg-orange-800 disabled:opacity-50 active:scale-[0.96] transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2"
            >
              {saving ? "Saving…" : `Save ${selected.size} keyword(s)`}
            </button>
          </div>
          {saveMsg && <p className="text-sm text-emerald-600">{saveMsg}</p>}
        </div>
      )}

      {/* Saved keywords */}
      <div>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-widest text-zinc-500">
          Saved keywords ({saved.length})
        </h2>
        {saved.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500">
            No saved keywords yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-zinc-200">
            <table className="w-full border-collapse">
              <thead className="bg-white">
                <tr>
                  <th className={th}>Keyword</th>
                  <th className={th}>List</th>
                  <th className={th}>Volume</th>
                  <th className={th}>Difficulty</th>
                  <th className={th}>CPC</th>
                  <th className={th}>Intent</th>
                </tr>
              </thead>
              <tbody>
                {saved.map((k) => (
                  <tr
                    key={k.id}
                    className="border-t border-zinc-200/60 hover:bg-zinc-100/60"
                  >
                    <td className={`${td} font-medium text-zinc-900`}>
                      {k.phrase}
                    </td>
                    <td className={td}>{k.list}</td>
                    <td className={td}>{fmt(k.volume)}</td>
                    <td className={td}>{fmt(k.difficulty)}</td>
                    <td className={td}>
                      {k.cpc == null ? "—" : `$${fmt(k.cpc, 2)}`}
                    </td>
                    <td className={td}>{k.intent}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
