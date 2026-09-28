// Marketr — Settings → Agents → Personas tab (Phase 13B, worker 5).
// The five canonical personas (lib/expert/personas) with their per-workspace
// human layer: voice (register, manner, quirks, taboos), continuity notes,
// uncertainty style. Edits upsert the PersonaProfile row for this workspace.

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil, User, X } from "lucide-react";
import {
  Chip,
  btnPrimary,
  btnGhost,
  infoNoteCls,
  inputCls,
} from "../../substrate/ui";

export interface PersonaProfileView {
  register: string;
  manner: string;
  quirks: string[];
  taboos: string[];
  continuityNotes: string;
  uncertaintyStyle: string;
  updatedAt: string;
}

export interface PersonaView {
  id: string;
  name: string;
  description: string;
  surfaces: string[];
  profile: PersonaProfileView | null;
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-stone-900/30" onClick={onClose} aria-hidden />
      <div className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-stone-200 bg-white p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-[15px] font-semibold text-stone-900">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-600"
          >
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function PersonasTab({
  workspaceId,
  personas,
  canEdit,
}: {
  workspaceId: string;
  personas: PersonaView[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<PersonaView | null>(null);
  const [form, setForm] = useState({ register: "", manner: "", quirks: "", taboos: "", continuityNotes: "", uncertaintyStyle: "" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  function openEdit(p: PersonaView) {
    setEditing(p);
    setForm({
      register: p.profile?.register ?? "",
      manner: p.profile?.manner ?? "",
      quirks: (p.profile?.quirks ?? []).join(", "),
      taboos: (p.profile?.taboos ?? []).join(", "),
      continuityNotes: p.profile?.continuityNotes ?? "",
      uncertaintyStyle: p.profile?.uncertaintyStyle ?? "",
    });
  }

  async function save() {
    if (!editing) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/agents/personas?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          agentId: editing.id,
          voice: {
            register: form.register.trim(),
            manner: form.manner.trim(),
            quirks: form.quirks.split(",").map((s) => s.trim()).filter(Boolean),
            taboos: form.taboos.split(",").map((s) => s.trim()).filter(Boolean),
          },
          continuityNotes: form.continuityNotes.trim(),
          uncertaintyStyle: form.uncertaintyStyle.trim(),
        }),
      });
      if (!r.ok) throw new Error("Save failed");
      setEditing(null);
      setNotice(`${editing.name} voice updated.`);
      router.refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  const field = "mb-3";
  const labelCls = "mb-1 block text-[12.5px] font-medium text-stone-700";

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
      <div className={infoNoteCls}>
        Each persona has a persistent voice and memory for this workspace — how it talks, what it
        remembers about your decisions, and how it expresses uncertainty. Tune them once; every agent
        output carries the voice.
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {personas.map((p) => (
          <article key={p.id} className="flex flex-col gap-2 rounded-lg border border-stone-200 bg-white p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700">
                  <User size={16} />
                </span>
                <div>
                  <h3 className="text-[13.5px] font-semibold text-stone-900">{p.name}</h3>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {p.surfaces.map((s) => (
                      <Chip key={s} tone="slate">{s}</Chip>
                    ))}
                    <Chip tone={p.profile ? "green" : "amber"}>{p.profile ? "tuned" : "default voice"}</Chip>
                  </div>
                </div>
              </div>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => openEdit(p)}
                  aria-label={`Edit ${p.name} voice`}
                  className="rounded-md p-1.5 text-stone-400 hover:bg-stone-100 hover:text-stone-700"
                >
                  <Pencil size={14} />
                </button>
              )}
            </div>
            <p className="line-clamp-3 text-[12.5px] leading-relaxed text-stone-500">{p.description}</p>
            {p.profile ? (
              <dl className="mt-1 space-y-1.5 border-t border-stone-100 pt-2 text-[12.5px]">
                {p.profile.register && (
                  <div className="flex gap-2"><dt className="w-24 shrink-0 font-medium text-stone-500">Register</dt><dd className="text-stone-800">{p.profile.register}</dd></div>
                )}
                {p.profile.manner && (
                  <div className="flex gap-2"><dt className="w-24 shrink-0 font-medium text-stone-500">Manner</dt><dd className="line-clamp-2 text-stone-800">{p.profile.manner}</dd></div>
                )}
                {p.profile.quirks.length > 0 && (
                  <div className="flex gap-2"><dt className="w-24 shrink-0 font-medium text-stone-500">Quirks</dt><dd className="text-stone-800">{p.profile.quirks.join(" · ")}</dd></div>
                )}
                {p.profile.taboos.length > 0 && (
                  <div className="flex gap-2"><dt className="w-24 shrink-0 font-medium text-stone-500">Taboos</dt><dd className="text-stone-800">{p.profile.taboos.join(" · ")}</dd></div>
                )}
                {p.profile.uncertaintyStyle && (
                  <div className="flex gap-2"><dt className="w-24 shrink-0 font-medium text-stone-500">Uncertainty</dt><dd className="line-clamp-2 text-stone-800">{p.profile.uncertaintyStyle}</dd></div>
                )}
              </dl>
            ) : (
              <p className="mt-1 border-t border-stone-100 pt-2 text-[12px] italic text-stone-400">
                No workspace voice yet — using the persona seed default.
              </p>
            )}
          </article>
        ))}
      </div>

      {editing && (
        <Modal title={`${editing.name} — voice`} onClose={() => setEditing(null)}>
          <div className={field}>
            <label className={labelCls}>Register — the diction it reaches for</label>
            <input value={form.register} onChange={(e) => setForm({ ...form, register: e.target.value })} placeholder="e.g. plain-spoken operator, no jargon" className={`${inputCls} w-full`} />
          </div>
          <div className={field}>
            <label className={labelCls}>Manner — how it carries itself</label>
            <textarea value={form.manner} onChange={(e) => setForm({ ...form, manner: e.target.value })} rows={2} placeholder="e.g. direct, a little dry, challenges lazy thinking" className={`${inputCls} w-full`} />
          </div>
          <div className={field}>
            <label className={labelCls}>Quirks — comma separated</label>
            <input value={form.quirks} onChange={(e) => setForm({ ...form, quirks: e.target.value })} placeholder="opens with the number, names the tradeoff" className={`${inputCls} w-full`} />
          </div>
          <div className={field}>
            <label className={labelCls}>Taboos — never does this, comma separated</label>
            <input value={form.taboos} onChange={(e) => setForm({ ...form, taboos: e.target.value })} placeholder="hype words, hedging with 'leverage'" className={`${inputCls} w-full`} />
          </div>
          <div className={field}>
            <label className={labelCls}>Continuity notes — what it remembers about you</label>
            <textarea value={form.continuityNotes} onChange={(e) => setForm({ ...form, continuityNotes: e.target.value })} rows={2} className={`${inputCls} w-full`} />
          </div>
          <div className={field}>
            <label className={labelCls}>Uncertainty style</label>
            <textarea value={form.uncertaintyStyle} onChange={(e) => setForm({ ...form, uncertaintyStyle: e.target.value })} rows={2} placeholder="e.g. gives the best read, names what it's unsure about, asks before high-stakes calls" className={`${inputCls} w-full`} />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditing(null)} className={btnGhost}>Cancel</button>
            <button type="button" onClick={save} disabled={busy} className={btnPrimary}>
              <Check size={14} /> Save voice
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
