// Marketr — Phase 13D Worker B: pronunciation dictionary UI.
// Dense table (term, phonetic, source) with add/edit/delete + "seed from
// company knowledge" (13B knowledge graph). House pattern diffed against
// StudioApp.tsx: brand vars only, dense table, hover rows.

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BookOpenText,
  Plus,
  Trash2,
  Sparkles,
  Loader2,
  AlertTriangle,
  Pencil,
} from "lucide-react";
import { confirmAction } from "@/lib/ui/feedback";

const inputCls =
  "rounded-md border border-line bg-paper px-2.5 py-1.5 text-[0.8125rem] text-ink placeholder:text-subtle focus:border-ink focus:outline-none";
const btnPrimary =
  "flex items-center gap-1.5 rounded-md bg-ink px-3 py-1.5 text-[0.8125rem] font-medium text-white hover:bg-ink-hover disabled:opacity-40";
const btnGhost =
  "flex items-center gap-1.5 rounded-md border border-line bg-paper px-2.5 py-1.5 text-[0.8125rem] text-muted hover:bg-hover-paper disabled:opacity-40";

interface Entry {
  id: string;
  term: string;
  phonetic: string;
  source: string;
  updatedAt: string;
}

function sourceChip(source: string) {
  const isKg = source === "knowledge_graph";
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[0.625rem] font-medium leading-tight ${
        isKg
          ? "border-ink/20 bg-canvas text-ink"
          : "border-line bg-paper text-muted"
      }`}
    >
      {isKg ? "knowledge graph" : "manual"}
    </span>
  );
}

export function PronunciationApp() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seedNote, setSeedNote] = useState<string | null>(null);
  const [newTerm, setNewTerm] = useState("");
  const [newPhonetic, setNewPhonetic] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPhonetic, setEditPhonetic] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/voice/pronunciation");
      if (!res.ok) throw new Error((await res.json()).error ?? "Load failed.");
      setEntries((await res.json()).entries ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const add = useCallback(async () => {
    if (!newTerm.trim() || !newPhonetic.trim()) {
      setError("Both term and phonetic respelling are required.");
      return;
    }
    setError(null);
    const res = await fetch("/api/voice/pronunciation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ term: newTerm, phonetic: newPhonetic }),
    });
    const body = await res.json();
    if (!res.ok) {
      setError(body.error ?? "Add failed.");
      return;
    }
    setEntries((prev) => {
      const rest = prev.filter((e) => e.term !== body.entry.term);
      return [...rest, body.entry].sort((a, b) => a.term.localeCompare(b.term));
    });
    setNewTerm("");
    setNewPhonetic("");
  }, [newTerm, newPhonetic]);

  const saveEdit = useCallback(
    async (entry: Entry) => {
      if (!editPhonetic.trim()) {
        setError("Phonetic respelling cannot be empty.");
        return;
      }
      const res = await fetch("/api/voice/pronunciation", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ term: entry.term, phonetic: editPhonetic }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Update failed.");
        return;
      }
      setEntries((prev) => prev.map((e) => (e.id === entry.id ? body.entry : e)));
      setEditingId(null);
    },
    [editPhonetic],
  );

  const remove = useCallback(async (id: string) => {
    if (!await confirmAction("Remove this pronunciation entry?")) return;
    await fetch(`/api/voice/pronunciation?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const seed = useCallback(async () => {
    setSeeding(true);
    setSeedNote(null);
    setError(null);
    try {
      const res = await fetch("/api/voice/pronunciation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "seed" }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Seed failed.");
      setEntries(body.entries ?? []);
      const s = body.seeded;
      setSeedNote(
        `Seeded ${s.inserted} term${s.inserted === 1 ? "" : "s"} from company knowledge` +
          (s.skippedExisting > 0 ? ` (${s.skippedExisting} already present — no duplicates).` : ".") +
          " Phonetics default to the term itself; edit them to respell.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Seed failed.");
    } finally {
      setSeeding(false);
    }
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="aos-heading">Pronunciation</h1>
        <p className="mt-0.5 text-[0.8125rem] text-muted">
          How brand terms are spoken in voiceovers — seeded from the company knowledge graph, editable by you.
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-[0.8125rem] text-failed-text">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {seedNote && (
        <div className="rounded-md border border-line bg-paper px-3 py-2 text-[0.8125rem] text-muted">
          {seedNote}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={newTerm}
          onChange={(e) => setNewTerm(e.target.value)}
          placeholder="Term (e.g. ShapesOS)"
          className={inputCls}
        />
        <input
          value={newPhonetic}
          onChange={(e) => setNewPhonetic(e.target.value)}
          placeholder="Phonetic respelling (e.g. marketer)"
          className={inputCls}
        />
        <button className={btnPrimary} onClick={add}>
          <Plus size={14} />
          Add entry
        </button>
        <button className={btnGhost} onClick={seed} disabled={seeding}>
          {seeding ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {seeding ? "Seeding…" : "Seed from company knowledge"}
        </button>
      </div>

      <div className="overflow-hidden rounded-lg border border-line bg-paper">
        <div className="border-b border-line px-4 py-2.5">
          <h2 className="flex items-center gap-1.5 text-[0.8125rem] font-semibold text-ink">
            <BookOpenText size={14} />
            Dictionary ({entries.length})
          </h2>
        </div>
        {loading ? (
          <p className="px-4 py-6 text-center text-[0.8125rem] text-subtle">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="px-4 py-6 text-center text-[0.8125rem] text-subtle">
            Empty dictionary — seed from company knowledge or add entries manually.
          </p>
        ) : (
          <table className="w-full text-[0.8125rem]">
            <thead>
              <tr className="border-b border-line bg-paper text-left text-[0.6875rem] text-muted">
                <th className="px-3 py-2 font-medium">Term</th>
                <th className="px-3 py-2 font-medium">Phonetic</th>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 font-medium">Updated</th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                  <td className="px-3 py-2 font-medium text-ink">{e.term}</td>
                  <td className="px-3 py-2 text-muted">
                    {editingId === e.id ? (
                      <input
                        value={editPhonetic}
                        onChange={(ev) => setEditPhonetic(ev.target.value)}
                        className={`${inputCls} w-full max-w-[240px]`}
                        autoFocus
                      />
                    ) : (
                      e.phonetic
                    )}
                  </td>
                  <td className="px-3 py-2">{sourceChip(e.source)}</td>
                  <td className="px-3 py-2 text-[0.75rem] text-muted">
                    {new Date(e.updatedAt).toLocaleDateString()}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1">
                      {editingId === e.id ? (
                        <>
                          <button className={btnPrimary} onClick={() => saveEdit(e)}>
                            Save
                          </button>
                          <button className={btnGhost} onClick={() => setEditingId(null)}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className={btnGhost}
                            title="Edit phonetic"
                            onClick={() => {
                              setEditingId(e.id);
                              setEditPhonetic(e.phonetic);
                            }}
                          >
                            <Pencil size={14} />
                          </button>
                          <button className={btnGhost} title="Delete" onClick={() => remove(e.id)}>
                            <Trash2 size={14} />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="rounded-md border border-line bg-paper px-3 py-2 text-[0.75rem] text-muted">
        Substitutions are longest-term-first, case-insensitive, and word-boundary matched — respellings never
        corrupt surrounding text. Each rendered voiceover records the exact snapshot applied.
      </div>
    </div>
  );
}
