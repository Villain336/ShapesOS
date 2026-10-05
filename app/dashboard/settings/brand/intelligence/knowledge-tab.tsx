// Marketr — Brand Intelligence → Knowledge tab (Phase 13B, worker 5).
// Company knowledge graph editor: dense table grouped by kind, with
// add/edit/pin/delete. Body is per-kind JSON (see DATA-MODEL contract);
// the table shows a compact summary, the editor takes JSON.

"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { BookOpen, Check, Pencil, Pin, PinOff, Plus, Trash2, TriangleAlert, X } from "lucide-react";
import { confirmAction } from "@/lib/ui/feedback";
// ── AOS atoms (local — app/dashboard/substrate/ui.tsx is owned by another slice) ──
const inputCls =
  "rounded-md border-[1.5px] border-control bg-paper px-2.5 py-1.5 text-[13px] text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
const btnPrimary =
  "inline-flex items-center gap-1.5 rounded-full bg-ink px-3 py-1.5 text-[13px] font-medium text-white aos-press hover:bg-night-hover disabled:opacity-40";
const btnGhost =
  "inline-flex items-center gap-1.5 rounded-full bg-paper px-2.5 py-1.5 text-[13px] font-medium text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";
const tableShell = "overflow-hidden rounded-lg border border-line bg-paper";
const theadCls = "border-b border-line text-left text-[12px] text-muted";
const thCls = "px-3 py-2 text-left font-medium";
const rowCls = "border-b border-line last:border-0 hover:bg-hover-paper";
const infoNoteCls = "rounded-lg border border-line bg-canvas p-4 text-[12.5px] text-muted";

// Statuses here are agent/provider states, not agent states — neutral chips.
function Chip({ children, tone: _tone }: { children: React.ReactNode; tone?: string }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-1.5 py-0.5 text-[10px] font-medium leading-tight text-muted shadow-control">
      {children}
    </span>
  );
}
const btnDeny =
  "inline-flex items-center gap-1.5 rounded-full bg-paper px-3 py-1.5 text-[13px] font-medium text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] aos-press hover:bg-failed-tint disabled:opacity-40";

export interface KnowledgeEntry {
  id: string;
  kind: string;
  title: string;
  body: Record<string, unknown>;
  confidence: number;
  pinned: boolean;
  updatedAt: string;
}

const KINDS = ["product", "pricing", "audience", "competitor", "pillar", "proof", "positioning", "other"] as const;

const KIND_HINT: Record<string, string> = {
  product: '{ "summary": "…", "features": ["…"], "url": "…" }',
  pricing: '{ "tiers": [{ "name": "…", "price": "…" }], "notes": "…" }',
  audience: '{ "segments": ["…"], "painPoints": ["…"] }',
  competitor: '{ "strengths": ["…"], "weaknesses": ["…"], "url": "…" }',
  pillar: '{ "statement": "…", "proofIds": ["…"] }',
  proof: '{ "claim": "…", "evidence": "…", "sourceUrl": "…" }',
  positioning: '{ "statement": "…", "differentiators": ["…"] }',
  other: '{ "…": "…" }',
};

function needsReview(e: { body: Record<string, unknown> }): boolean {
  return e.body?.needsReview === true;
}

function bodySummary(kind: string, body: Record<string, unknown>): string {
  const b = body ?? {};
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
  const arr = (k: string) => (Array.isArray(b[k]) ? (b[k] as unknown[]).length : 0);
  switch (kind) {
    case "product":
      return [str("summary"), arr("features") ? `${arr("features")} features` : ""].filter(Boolean).join(" · ") || "—";
    case "pricing":
      return arr("tiers") ? `${arr("tiers")} tiers${str("notes") ? ` — ${str("notes")}` : ""}` : str("notes") || "—";
    case "audience":
      return [arr("segments") ? `${arr("segments")} segments` : "", arr("painPoints") ? `${arr("painPoints")} pain points` : ""].filter(Boolean).join(" · ") || "—";
    case "competitor":
      return [arr("strengths") ? `${arr("strengths")} strengths` : "", arr("weaknesses") ? `${arr("weaknesses")} weaknesses` : ""].filter(Boolean).join(" · ") || "—";
    case "pillar":
    case "positioning":
      return str("statement") || "—";
    case "proof":
      return str("claim") || str("evidence") || "—";
    default: {
      const keys = Object.keys(b);
      return keys.length ? `${keys.length} field${keys.length === 1 ? "" : "s"}: ${keys.slice(0, 3).join(", ")}` : "—";
    }
  }
}

// Spec switch (44x26 pill track, white 20px knob) with a visible label.
function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] text-muted">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors ${
          checked ? "bg-ink" : "bg-disabled-fg"
        }`}
      >
        <span
          className={`absolute top-[3px] h-5 w-5 rounded-full bg-white transition-all ${
            checked ? "left-[21px]" : "left-[3px]"
          }`}
        />
      </button>
      {label}
    </label>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink/30" onClick={onClose} aria-hidden />
      <div className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-line bg-paper p-5 shadow-overlay">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-subtle hover:bg-hover-paper hover:text-muted">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function KnowledgeTab({
  workspaceId,
  entries,
  canEdit,
}: {
  workspaceId: string;
  entries: KnowledgeEntry[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [kindFilter, setKindFilter] = useState("");
  const [editing, setEditing] = useState<KnowledgeEntry | "new" | null>(null);
  const [form, setForm] = useState({ kind: "product", title: "", body: "", pinned: false });
  const [confirmDelete, setConfirmDelete] = useState<KnowledgeEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const ws = `workspaceId=${encodeURIComponent(workspaceId)}`;

  const filtered = useMemo(
    () => (kindFilter ? entries.filter((e) => e.kind === kindFilter) : entries),
    [entries, kindFilter],
  );

  const pendingReview = useMemo(() => entries.filter(needsReview), [entries]);

  function openNew() {
    setForm({ kind: "product", title: "", body: KIND_HINT.product, pinned: false });
    setEditing("new");
  }
  function openEdit(e: KnowledgeEntry) {
    setForm({ kind: e.kind, title: e.title, body: JSON.stringify(e.body, null, 2), pinned: e.pinned });
    setEditing(e);
  }

  async function save() {
    let parsed: Record<string, unknown>;
    try {
      parsed = form.body.trim() ? (JSON.parse(form.body) as Record<string, unknown>) : {};
    } catch {
      setNotice("Body is not valid JSON.");
      return;
    }
    if (!form.title.trim()) {
      setNotice("Title is required.");
      return;
    }
    setBusy(true);
    try {
      const isNew = editing === "new";
      const url = isNew ? `/api/intelligence/knowledge?${ws}` : `/api/intelligence/knowledge/${(editing as KnowledgeEntry).id}?${ws}`;
      const r = await fetch(url, {
        method: isNew ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          isNew
            ? { workspaceId, kind: form.kind, title: form.title.trim(), body: parsed, pinned: form.pinned }
            : { workspaceId, title: form.title.trim(), body: parsed, pinned: form.pinned },
        ),
      });
      if (!r.ok) throw new Error("Save failed");
      setEditing(null);
      setNotice(isNew ? "Knowledge entry added." : "Knowledge entry updated.");
      router.refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function togglePin(e: KnowledgeEntry) {
    setBusy(true);
    try {
      const r = await fetch(`/api/intelligence/knowledge/${e.id}?${ws}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, pinned: !e.pinned }),
      });
      if (!r.ok) throw new Error("Pin toggle failed");
      router.refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Pin toggle failed");
    } finally {
      setBusy(false);
    }
  }

  async function acceptProposal(e: KnowledgeEntry) {
    setBusy(true);
    try {
      const { needsReview: _drop, ...rest } = e.body ?? {};
      const r = await fetch(`/api/intelligence/knowledge/${e.id}?${ws}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, body: rest }),
      });
      if (!r.ok) throw new Error("Accept failed");
      setNotice("Learner proposal accepted — entry is now live.");
      router.refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Accept failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(e: KnowledgeEntry) {
    const ok = await confirmAction({
      title: "Delete this knowledge entry?",
      description: "Agents stop using it in their answers.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/intelligence/knowledge/${e.id}?${ws}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      if (!r.ok) throw new Error("Delete failed");
      setConfirmDelete(null);
      setNotice("Entry deleted.");
      router.refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {notice && (
        <div className={infoNoteCls} role="status">
          <span className="flex items-center gap-2">
            <Check size={14} className="shrink-0 text-muted" />
            {notice}
            <button type="button" onClick={() => setNotice(null)} className="ml-auto text-subtle hover:text-muted" aria-label="Dismiss">
              <X size={14} />
            </button>
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {pendingReview.length > 0 && (
          <div className="w-full rounded-lg border border-line bg-needs-tint aos-shape aos-shape--needs aos-shape--edged p-3">
            <p className="text-[13px] font-medium text-ink">
              {pendingReview.length} learner proposal{pendingReview.length === 1 ? "" : "s"} waiting for review
            </p>
            <p className="text-[12.5px] text-muted">
              Accept the entries you agree with — they go live only when you accept them.
            </p>
          </div>
        )}
        <div className="flex items-center gap-1.5 text-[13px] text-muted">
          <BookOpen size={14} />
          <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} className={inputCls} aria-label="Filter by kind">
            <option value="">All kinds</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </div>
        <span className="text-[12.5px] text-subtle">{filtered.length} entr{filtered.length === 1 ? "y" : "ies"}</span>
        {canEdit && (
          <button type="button" onClick={openNew} className={`${btnPrimary} ml-auto`}>
            <Plus size={14} /> Add entry
          </button>
        )}
      </div>

      <div className={tableShell}>
        <table className="w-full text-[13px]">
          <thead className={theadCls}>
            <tr>
              <th className={thCls}>Title</th>
              <th className={`${thCls} w-28`}>Kind</th>
              <th className={thCls}>Summary</th>
              <th className={`${thCls} w-24`}>Pinned</th>
              {canEdit && <th className={`${thCls} w-28 text-right`}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr className={rowCls}>
                <td colSpan={canEdit ? 5 : 4} className="px-3 py-8 text-center text-muted">
                  No knowledge entries yet — add products, pricing, audiences, competitors, pillars, proof, and positioning so agents know the business.
                </td>
              </tr>
            )}
            {filtered.map((e) => (
              <tr key={e.id} className={rowCls}>
                <td className="px-3 py-2.5 font-medium text-ink">
                  {e.title}
                  {needsReview(e) && (
                    <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-needs-tint px-2 py-0.5 text-[11px] font-medium text-ink aos-shape aos-shape--needs aos-shape--edged">
                      <TriangleAlert size={11} /> Needs review
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5"><Chip>{e.kind}</Chip></td>
                <td className="max-w-[340px] truncate px-3 py-2.5 text-muted" title={bodySummary(e.kind, e.body)}>
                  {bodySummary(e.kind, e.body)}
                </td>
                <td className="px-3 py-2.5">
                  {e.pinned ? (
                    <span className="inline-flex items-center gap-1 text-[12px] font-medium text-muted">
                      <Pin size={12} /> pinned
                    </span>
                  ) : (
                    <span className="text-[12px] text-subtle">—</span>
                  )}
                </td>
                {canEdit && (
                  <td className="px-3 py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      {needsReview(e) && (
                        <button type="button" aria-label="Accept learner proposal" title="Accept — mark reviewed and make live" onClick={() => acceptProposal(e)} disabled={busy} className="rounded-md p-1.5 text-ink hover:bg-hover-paper">
                          <Check size={14} />
                        </button>
                      )}
                      <button type="button" aria-label={e.pinned ? "Unpin" : "Pin"} title={e.pinned ? "Unpin — learner may refine" : "Pin — learner cannot modify"} onClick={() => togglePin(e)} disabled={busy} className="rounded-md p-1.5 text-subtle hover:bg-hover-paper hover:text-muted">
                        {e.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                      </button>
                      <button type="button" aria-label="Edit entry" onClick={() => openEdit(e)} className="rounded-md p-1.5 text-subtle hover:bg-hover-paper hover:text-muted">
                        <Pencil size={14} />
                      </button>
                      <button type="button" aria-label="Delete entry" onClick={() => setConfirmDelete(e)} className="rounded-md p-1.5 text-subtle hover:bg-failed-tint hover:text-failed-text">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={infoNoteCls}>
        Pinned entries are read-only to the learner — consolidation proposes changes to unpinned entries only, and those arrive as reviewable diffs.
      </p>

      {editing && (
        <Modal title={editing === "new" ? "Add knowledge entry" : "Edit knowledge entry"} onClose={() => setEditing(null)}>
          <div className="mb-3 grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-[12.5px] font-medium text-muted">Kind</label>
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value, body: KIND_HINT[e.target.value] ?? "{}" })} className={`${inputCls} w-full`} disabled={editing !== "new"}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[12.5px] font-medium text-muted">Title</label>
              <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className={`${inputCls} w-full`} placeholder="e.g. Acme Starter plan" />
            </div>
          </div>
          <label className="mb-1 block text-[12.5px] font-medium text-muted">Body — JSON</label>
          <textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} rows={8} spellCheck={false} className={`${inputCls} mb-3 w-full font-mono text-[12px]`} />
          <div className="mb-4">
            <Switch checked={form.pinned} onChange={(v) => setForm({ ...form, pinned: v })} label="Pin — the learner may never modify this" />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditing(null)} className={btnGhost}>Cancel</button>
            <button type="button" onClick={save} disabled={busy} className={btnPrimary}>
              <Check size={14} /> Save
            </button>
          </div>
        </Modal>
      )}

      {confirmDelete && (
        <Modal title="Delete this entry?" onClose={() => setConfirmDelete(null)}>
          <p className="mb-1 text-[13px] text-ink">{confirmDelete.title}</p>
          <p className="mb-4 text-[12.5px] text-muted">Agents will no longer know this. This cannot be undone.</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setConfirmDelete(null)} className={btnGhost}>Cancel</button>
            <button type="button" onClick={() => remove(confirmDelete)} disabled={busy} className={btnDeny}>
              <Trash2 size={14} /> Delete
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
