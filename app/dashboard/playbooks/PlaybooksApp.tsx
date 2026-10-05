// Marketr — Agent Playbooks list (Phase 9 M5, client).
// Dense table of playbooks + create modal + propose-from-learning.

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BookOpen, Loader2, Plus, Search, Sparkles, X } from "lucide-react";
import { closeOnEscape } from "@/lib/ui/keyboard";

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

// ── Atoms (Agentic OS) ───────────────────────────────────────────────────────

const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";

const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40";
const btnGhost =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";

// Source, lifecycle status, and production version are categories — always a
// neutral chip. Lift deltas are analytic, never status-colored.
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-xs font-semibold text-muted shadow-control">
      {children}
    </span>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text">
      <span className="mt-1 size-2.5 shrink-0 rounded-[2px] bg-failed" aria-hidden />
      <span>{message}</span>
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4" role="presentation" onClick={onClose} onKeyDown={closeOnEscape(onClose)}>
      <div
        className="relative w-full max-w-lg rounded-lg bg-paper p-5 shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <h3 className="aos-subheading">{title}</h3>
          <button onClick={onClose} className="rounded-full p-1 text-subtle hover:bg-hover-paper hover:text-ink" aria-label="Close">
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
        <div className="mb-3"><ErrorBox message={error} /></div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select value={fSource} onChange={(e) => setFSource(e.target.value)} className={inputCls} aria-label="Filter by source">
          <option value="">All sources</option>
          <option value="learned">Learned</option>
          <option value="community">Community</option>
          <option value="seed">Seed</option>
        </select>
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
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

      <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line text-xs font-semibold text-muted">
              <th className="px-3 py-2 font-semibold">Name</th>
              <th className="px-3 py-2 font-semibold">Source</th>
              <th className="px-3 py-2 font-semibold">Production</th>
              <th className="px-3 py-2 font-semibold">Status</th>
              <th className="px-3 py-2 font-semibold">Versions</th>
              <th className="px-3 py-2 font-semibold">Outcome lift</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => (
              <tr key={p.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                <td className="px-3 py-2">
                  <Link
                    href={`/dashboard/playbooks/${p.id}`}
                    className="flex items-center gap-1.5 font-medium text-ink hover:text-focus hover:underline"
                  >
                    <BookOpen size={14} className="text-subtle" />
                    {p.name}
                  </Link>
                  {p.description && (
                    <div className="mt-0.5 truncate text-xs text-muted" title={p.description}>
                      {p.description}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Chip>{p.source}</Chip>
                </td>
                <td className="px-3 py-2">
                  {p.productionVersion != null ? (
                    <Chip>v{p.productionVersion}</Chip>
                  ) : (
                    <span className="text-subtle">—</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Chip>{p.productionStatus ?? "unpromoted"}</Chip>
                </td>
                <td className="px-3 py-2 text-muted">
                  {p.versionCount} <span className="text-subtle">(latest v{p.latestVersion})</span>
                </td>
                <td className="px-3 py-2">
                  {p.outcomeLift ? (
                    <span>
                      <span className="font-semibold tabular-nums text-ink">
                        {p.outcomeLift.liftPct >= 0 ? "+" : ""}{p.outcomeLift.liftPct}%
                      </span>{" "}
                      <span className="text-muted">{p.outcomeLift.metric}</span>
                    </span>
                  ) : (
                    <span className="text-subtle">—</span>
                  )}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && !loading && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-sm text-subtle">
                  No playbooks yet — create the first one with “New playbook”.
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-sm text-subtle">
                  <Loader2 size={16} className="mx-auto aos-spin" />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 rounded-lg bg-paper px-3 py-2 text-xs text-muted shadow-hairline">
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
        <div className="mb-3"><ErrorBox message={error} /></div>
      )}
      <label className="mb-1 block text-xs font-semibold text-muted">Name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Friday GBP review sprint" className={`${inputCls} mb-3 w-full`} />
      <label className="mb-1 block text-xs font-semibold text-muted">Source</label>
      <select value={source} onChange={(e) => setSource(e.target.value as Source)} className={`${inputCls} mb-3 w-full`}>
        <option value="seed">Seed — hand-authored procedure</option>
        <option value="learned">Learned — promoted from Growth Memory</option>
        <option value="community">Community — imported from the community</option>
      </select>
      <label className="mb-1 block text-xs font-semibold text-muted">Description (optional)</label>
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
          {saving ? <Loader2 size={14} className="aos-spin" /> : <Plus size={14} />} Create playbook
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
      <div className="mb-3 rounded-lg bg-canvas px-3 py-2 text-xs text-muted">
        The playbook is drafted from the learning and lands at status <b className="text-ink">review</b>. A human must
        advance it through the lifecycle before it can be used. Nothing is auto-promoted.
      </div>
      {error && (
        <div className="mb-3"><ErrorBox message={error} /></div>
      )}
      <label className="mb-1 block text-xs font-semibold text-muted">Learning ID</label>
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
          {saving ? <Loader2 size={14} className="aos-spin" /> : <Sparkles size={14} />} Propose
          playbook
        </button>
      </div>
    </Modal>
  );
}
