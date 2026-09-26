// Marketr — Agent Playbooks list (Phase 9 M5, client).
// Dense table of playbooks + create modal + propose-from-learning.

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BookOpen, Loader2, Plus, Search, Sparkles, X } from "lucide-react";

type Source = "learned" | "community" | "seed";

interface OutcomeLift {
  metric: string;
  liftPct: number;
  basis: string;
  recordedAt: string | null;
}

interface PlaybookListItem {
  id: string;
  name: string;
  source: Source;
  description: string | null;
  productionVersion: number | null;
  productionStatus: string | null;
  latestVersion: number;
  versionCount: number;
  outcomeLift: OutcomeLift | null;
  createdAt: string;
}

const inputCls =
  "rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-violet-400 focus:outline-none";
const btnPrimary =
  "flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-violet-700 disabled:opacity-40";
const btnGhost =
  "flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-700 hover:bg-stone-50 disabled:opacity-40";

function Chip({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "violet" | "green" | "amber" | "red" | "blue" }) {
  const tones: Record<string, string> = {
    slate: "bg-slate-100 text-slate-600 border-slate-200",
    violet: "bg-violet-50 text-violet-700 border-violet-200",
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    red: "bg-red-50 text-red-700 border-red-200",
    blue: "bg-blue-50 text-blue-700 border-blue-200",
  };
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight ${tones[tone]}`}>
      {children}
    </span>
  );
}

function sourceTone(s: Source): "violet" | "blue" | "slate" {
  return s === "learned" ? "violet" : s === "community" ? "blue" : "slate";
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-stone-900/30" onClick={onClose} />
      <div className="relative w-full max-w-lg rounded-lg border border-stone-200 bg-white p-5 shadow-xl">
        <div className="mb-4 flex items-start justify-between">
          <h3 className="text-[15px] font-semibold text-stone-900">{title}</h3>
          <button onClick={onClose} className="rounded-md p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function PlaybooksApp() {
  const [playbooks, setPlaybooks] = useState<PlaybookListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [fSource, setFSource] = useState("");
  const [q, setQ] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [proposeOpen, setProposeOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/playbooks", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Failed to load playbooks.");
      setPlaybooks(j.playbooks ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load playbooks.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = playbooks.filter(
    (p) =>
      (!fSource || p.source === fSource) &&
      (!q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase())),
  );

  return (
    <div>
      {error && (
        <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select value={fSource} onChange={(e) => setFSource(e.target.value)} className={inputCls}>
          <option value="">All sources</option>
          <option value="learned">Learned</option>
          <option value="community">Community</option>
          <option value="seed">Seed</option>
        </select>
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search playbooks…"
            className={`${inputCls} w-44 pl-8`}
          />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => setProposeOpen(true)} className={btnGhost} title="Draft a playbook from a Growth Memory learning">
            <Sparkles size={14} /> Propose from learning
          </button>
          <button onClick={() => setCreateOpen(true)} className={btnPrimary}>
            <Plus size={14} /> New playbook
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Source</th>
              <th className="px-3 py-2 font-medium">Production</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Versions</th>
              <th className="px-3 py-2 font-medium">Outcome lift</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => (
              <tr key={p.id} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                <td className="px-3 py-2">
                  <Link
                    href={`/dashboard/playbooks/${p.id}`}
                    className="flex items-center gap-1.5 font-medium text-stone-900 hover:text-violet-700"
                  >
                    <BookOpen size={14} className="text-stone-400" />
                    {p.name}
                  </Link>
                  {p.description && (
                    <div className="mt-0.5 truncate text-[12px] text-stone-500" title={p.description}>
                      {p.description}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Chip tone={sourceTone(p.source)}>{p.source}</Chip>
                </td>
                <td className="px-3 py-2">
                  {p.productionVersion != null ? (
                    <Chip tone="violet">v{p.productionVersion}</Chip>
                  ) : (
                    <span className="text-stone-400">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-stone-600">{p.productionStatus ?? "unpromoted"}</td>
                <td className="px-3 py-2 text-stone-600">
                  {p.versionCount} <span className="text-stone-400">(latest v{p.latestVersion})</span>
                </td>
                <td className="px-3 py-2">
                  {p.outcomeLift ? (
                    <span className="text-stone-700">
                      <span className="font-medium text-emerald-700">
                        {p.outcomeLift.liftPct >= 0 ? "+" : ""}{p.outcomeLift.liftPct}%
                      </span>{" "}
                      <span className="text-stone-500">{p.outcomeLift.metric}</span>
                    </span>
                  ) : (
                    <span className="text-stone-400">—</span>
                  )}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && !loading && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-[13px] text-stone-400">
                  No playbooks yet — create the first one with “New playbook”.
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-[13px] text-stone-400">
                  <Loader2 size={16} className="mx-auto animate-spin" />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-[12px] text-stone-500">
        Versions are immutable — a change is a new version. Rollback moves the production pointer;
        nothing is ever rewritten. Every run records the resolved version.
      </div>

      {createOpen && (
        <CreateModal
          onClose={() => setCreateOpen(false)}
          onDone={() => {
            setCreateOpen(false);
            load();
          }}
        />
      )}
      {proposeOpen && (
        <ProposeModal
          onClose={() => setProposeOpen(false)}
          onDone={() => {
            setProposeOpen(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function CreateModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [source, setSource] = useState<Source>("seed");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/playbooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), source, description: description.trim() || null }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Create failed.");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="New playbook" onClose={onClose}>
      {error && (
        <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </div>
      )}
      <label className="mb-1 block text-[12px] font-medium text-stone-600">Name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Friday GBP review sprint" className={`${inputCls} mb-3 w-full`} />
      <label className="mb-1 block text-[12px] font-medium text-stone-600">Source</label>
      <select value={source} onChange={(e) => setSource(e.target.value as Source)} className={`${inputCls} mb-3 w-full`}>
        <option value="seed">Seed — hand-authored procedure</option>
        <option value="learned">Learned — promoted from Growth Memory</option>
        <option value="community">Community — imported from the community</option>
      </select>
      <label className="mb-1 block text-[12px] font-medium text-stone-600">Description (optional)</label>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={3}
        className={`${inputCls} mb-4 w-full`}
        placeholder="What this playbook is for…"
      />
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={btnGhost} disabled={saving}>
          Cancel
        </button>
        <button onClick={save} className={btnPrimary} disabled={saving}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Create playbook
        </button>
      </div>
    </Modal>
  );
}

function ProposeModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [learningId, setLearningId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!learningId.trim()) {
      setError("Learning ID is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/playbooks/propose-from-learning", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ learningId: learningId.trim() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Proposal failed.");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Proposal failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Propose playbook from a Growth Memory learning" onClose={onClose}>
      <div className="mb-3 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-[12px] text-stone-500">
        The playbook is drafted from the learning and lands at status <b>review</b>. A human must
        advance it through the lifecycle before it can be used. Nothing is auto-promoted.
      </div>
      {error && (
        <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </div>
      )}
      <label className="mb-1 block text-[12px] font-medium text-stone-600">Learning ID</label>
      <input
        value={learningId}
        onChange={(e) => setLearningId(e.target.value)}
        placeholder="Paste a memory_learnings row id…"
        className={`${inputCls} mb-4 w-full font-mono`}
      />
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={btnGhost} disabled={saving}>
          Cancel
        </button>
        <button onClick={save} className={btnPrimary} disabled={saving}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Propose
          playbook
        </button>
      </div>
    </Modal>
  );
}
