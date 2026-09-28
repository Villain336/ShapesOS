// Marketr — Brand Intelligence → Style Rules tab (Phase 13B, worker 5).
// Hard constraints checked on every output pre-delivery: banned words,
// required lines, disclaimers, tone guidance. Severity block = refuse
// delivery, flag = warn. Learner proposals arrive active=false and go live
// only on accept; pinned rules are read-only to the learner.

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil, Plus, ShieldAlert, Trash2, X } from "lucide-react";
import {
  Chip,
  btnPrimary,
  btnGhost,
  tableShell,
  theadCls,
  thCls,
  rowCls,
  infoNoteCls,
  inputCls,
} from "../../../substrate/ui";

export interface StyleRuleView {
  id: string;
  kind: string;
  pattern: string;
  replacement: string | null;
  severity: string;
  pinned: boolean;
  active: boolean;
  source: string;
  updatedAt: string;
}

const KINDS = ["ban", "require", "disclaimer", "tone"] as const;

function kindHint(kind: string): string {
  switch (kind) {
    case "ban": return "Forbidden phrase or regex — e.g. \\bguaranteed\\b";
    case "require": return "Required line — e.g. Results vary; past performance…";
    case "disclaimer": return "Compliance text — e.g. Not financial advice.";
    case "tone": return "Guidance snippet — e.g. Never sound like a press release.";
    default: return "";
  }
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-stone-900/30" onClick={onClose} aria-hidden />
      <div className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-stone-200 bg-white p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-[15px] font-semibold text-stone-900">{title}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-600">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function StyleRulesTab({
  workspaceId,
  rules,
  canEdit,
}: {
  workspaceId: string;
  rules: StyleRuleView[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<StyleRuleView | "new" | null>(null);
  const [form, setForm] = useState({ kind: "ban", pattern: "", replacement: "", severity: "flag", pinned: false, active: true });
  const [confirmDelete, setConfirmDelete] = useState<StyleRuleView | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const ws = `workspaceId=${encodeURIComponent(workspaceId)}`;

  function openNew() {
    setForm({ kind: "ban", pattern: "", replacement: "", severity: "flag", pinned: false, active: true });
    setEditing("new");
  }
  function openEdit(r: StyleRuleView) {
    setForm({ kind: r.kind, pattern: r.pattern, replacement: r.replacement ?? "", severity: r.severity, pinned: r.pinned, active: r.active });
    setEditing(r);
  }

  async function save() {
    if (!form.pattern.trim()) {
      setNotice("Pattern is required.");
      return;
    }
    setBusy(true);
    try {
      const isNew = editing === "new";
      const url = isNew ? `/api/intelligence/style-rules?${ws}` : `/api/intelligence/style-rules/${(editing as StyleRuleView).id}?${ws}`;
      const r = await fetch(url, {
        method: isNew ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          ...(isNew ? { kind: form.kind } : {}),
          pattern: form.pattern.trim(),
          replacement: form.replacement.trim() || null,
          severity: form.severity,
          pinned: form.pinned,
          active: form.active,
        }),
      });
      if (!r.ok) throw new Error("Save failed");
      setEditing(null);
      setNotice(isNew ? "Style rule added." : "Style rule updated.");
      router.refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(r: StyleRuleView) {
    setBusy(true);
    try {
      const res = await fetch(`/api/intelligence/style-rules/${r.id}?${ws}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, active: !r.active }),
      });
      if (!res.ok) throw new Error("Toggle failed");
      router.refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Toggle failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(r: StyleRuleView) {
    setBusy(true);
    try {
      const res = await fetch(`/api/intelligence/style-rules/${r.id}?${ws}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      if (!res.ok) throw new Error("Delete failed");
      setConfirmDelete(null);
      setNotice("Rule deleted.");
      router.refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  const proposed = rules.filter((r) => !r.active && r.source === "consolidation");

  return (
    <div className="flex flex-col gap-4">
      {notice && (
        <div className={infoNoteCls} role="status">
          <span className="flex items-center gap-2">
            <Check size={14} className="shrink-0 text-emerald-600" />
            {notice}
            <button type="button" onClick={() => setNotice(null)} className="ml-auto text-stone-400 hover:text-stone-600" aria-label="Dismiss">
              <X size={14} />
            </button>
          </span>
        </div>
      )}

      {proposed.length > 0 && canEdit && (
        <div className="rounded-lg border border-brand-600/30 bg-brand-50/40 p-4">
          <p className="text-[13px] font-medium text-stone-900">
            {proposed.length} proposed rule{proposed.length === 1 ? "" : "s"} from the learner
          </p>
          <p className="text-[12.5px] text-stone-500">
            They arrive inactive and go live only when you accept them — toggle a rule on to accept it.
          </p>
        </div>
      )}

      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-[13px] text-stone-500">
          <ShieldAlert size={14} />
          {rules.length} rule{rules.length === 1 ? "" : "s"} · checked on every output before delivery
        </span>
        {canEdit && (
          <button type="button" onClick={openNew} className={`${btnPrimary} ml-auto`}>
            <Plus size={14} /> Add rule
          </button>
        )}
      </div>

      <div className={tableShell}>
        <table className="w-full text-[13px]">
          <thead className={theadCls}>
            <tr>
              <th className={thCls}>Rule</th>
              <th className={`${thCls} w-28`}>Kind</th>
              <th className={`${thCls} w-24`}>Severity</th>
              <th className={`${thCls} w-20`}>Active</th>
              <th className={`${thCls} w-20`}>Pinned</th>
              {canEdit && <th className={`${thCls} w-20 text-right`}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {rules.length === 0 && (
              <tr className={rowCls}>
                <td colSpan={canEdit ? 6 : 5} className="px-3 py-8 text-center text-stone-500">
                  No style rules yet — add banned phrases, required disclaimers, and tone guidance. Hard constraints always win on conflict.
                </td>
              </tr>
            )}
            {rules.map((r) => (
              <tr key={r.id} className={`${rowCls} ${!r.active ? "opacity-60" : ""}`}>
                <td className="max-w-[380px] px-3 py-2.5">
                  <p className="truncate font-medium text-stone-900" title={r.pattern}>{r.pattern}</p>
                  {r.replacement && <p className="truncate text-[12px] text-stone-500" title={r.replacement}>→ {r.replacement}</p>}
                </td>
                <td className="px-3 py-2.5"><Chip tone="slate">{r.kind}</Chip></td>
                <td className="px-3 py-2.5">
                  <Chip tone={r.severity === "block" ? "red" : "amber"}>{r.severity}</Chip>
                </td>
                <td className="px-3 py-2.5">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={r.active}
                    aria-label={`Rule ${r.active ? "active" : "inactive"} — toggle`}
                    disabled={!canEdit || busy}
                    onClick={() => toggleActive(r)}
                    className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-40 ${r.active ? "bg-brand-600" : "bg-stone-300"}`}
                  >
                    <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${r.active ? "left-[18px]" : "left-0.5"}`} />
                  </button>
                </td>
                <td className="px-3 py-2.5 text-[12px] text-stone-500">{r.pinned ? "pinned" : "—"}</td>
                {canEdit && (
                  <td className="px-3 py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      <button type="button" aria-label="Edit rule" onClick={() => openEdit(r)} className="rounded-md p-1.5 text-stone-400 hover:bg-stone-100 hover:text-stone-700">
                        <Pencil size={14} />
                      </button>
                      <button type="button" aria-label="Delete rule" onClick={() => setConfirmDelete(r)} className="rounded-md p-1.5 text-stone-400 hover:bg-red-50 hover:text-red-600">
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
        <span className="font-medium text-stone-700">block</span> refuses delivery of a violating output;{" "}
        <span className="font-medium text-stone-700">flag</span> warns before it goes out. Rules are checked style-rules → voice → knowledge → lessons, hard constraints first.
      </p>

      {editing && (
        <Modal title={editing === "new" ? "Add style rule" : "Edit style rule"} onClose={() => setEditing(null)}>
          <div className="mb-3 grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-[12.5px] font-medium text-stone-700">Kind</label>
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} className={`${inputCls} w-full`} disabled={editing !== "new"}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[12.5px] font-medium text-stone-700">Severity</label>
              <select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })} className={`${inputCls} w-full`}>
                <option value="flag">flag — warn</option>
                <option value="block">block — refuse delivery</option>
              </select>
            </div>
          </div>
          <label className="mb-1 block text-[12.5px] font-medium text-stone-700">Pattern</label>
          <input value={form.pattern} onChange={(e) => setForm({ ...form, pattern: e.target.value })} placeholder={kindHint(form.kind)} className={`${inputCls} mb-3 w-full`} />
          <label className="mb-1 block text-[12.5px] font-medium text-stone-700">
            Replacement <span className="font-normal text-stone-400">(optional — for ban rules)</span>
          </label>
          <input value={form.replacement} onChange={(e) => setForm({ ...form, replacement: e.target.value })} className={`${inputCls} mb-3 w-full`} placeholder="What to say instead" />
          <div className="mb-4 flex items-center gap-4">
            <label className="flex cursor-pointer items-center gap-2 text-[13px] text-stone-700">
              <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} className="accent-brand-600" />
              Active
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-[13px] text-stone-700">
              <input type="checkbox" checked={form.pinned} onChange={(e) => setForm({ ...form, pinned: e.target.checked })} className="accent-brand-600" />
              Pin — learner cannot modify
            </label>
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
        <Modal title="Delete this rule?" onClose={() => setConfirmDelete(null)}>
          <p className="mb-1 text-[13px] text-stone-700">{confirmDelete.pattern}</p>
          <p className="mb-4 text-[12.5px] text-stone-500">Outputs will no longer be checked against it.</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setConfirmDelete(null)} className={btnGhost}>Cancel</button>
            <button type="button" onClick={() => remove(confirmDelete)} disabled={busy} className="flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-red-700 disabled:opacity-40">
              <Trash2 size={14} /> Delete
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
