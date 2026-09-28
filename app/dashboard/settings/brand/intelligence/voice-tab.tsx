// Marketr — Brand Intelligence → Brand Voice tab (Phase 13B, worker 5).
// The living Brand Voice: dimensions display, learner-proposed updates as a
// reviewable diff (approve/reject), pin/lock, user edits, re-derive.

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  Lock,
  LockOpen,
  Megaphone,
  Pencil,
  RefreshCw,
  X,
} from "lucide-react";
import {
  Chip,
  btnPrimary,
  btnGhost,
  infoNoteCls,
  inputCls,
} from "../../../substrate/ui";

export interface VoiceProfileView {
  dimensions: Record<string, unknown>;
  derivedFrom: Record<string, unknown>;
  confidence: number;
  pinnedByUser: boolean;
  pendingUpdates: { proposedAt?: string; dimensions?: Record<string, unknown>; rationale?: string } | null;
  updatedAt: string;
}

const DIM_META: { key: string; label: string; list: boolean }[] = [
  { key: "vocabulary", label: "Vocabulary", list: true },
  { key: "rhythm", label: "Rhythm", list: false },
  { key: "formality", label: "Formality", list: false },
  { key: "pov", label: "Point of view", list: false },
  { key: "humor", label: "Humor", list: false },
  { key: "doExamples", label: "Do", list: true },
  { key: "dontExamples", label: "Don't", list: true },
];

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function list(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
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

export default function VoiceTab({
  workspaceId,
  profile,
  canEdit,
}: {
  workspaceId: string;
  profile: VoiceProfileView | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});

  const dims = profile?.dimensions ?? {};
  const pending = profile?.pendingUpdates;
  const pendingDims = pending?.dimensions ?? {};
  const derived = profile?.derivedFrom ?? {};

  async function action(act: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    try {
      // Canonical namespace: /api/intelligence/* (Phase 13B worker 4 core).
      const ws = encodeURIComponent(workspaceId);
      let url = "";
      let method = "POST";
      let payload: Record<string, unknown> = { workspaceId };
      if (act === "update") {
        url = `/api/intelligence/voice?workspaceId=${ws}`;
        method = "PATCH";
        payload = { workspaceId, dimensions: extra.dimensions };
      } else if (act === "acceptPending") {
        url = `/api/intelligence/voice/approve-pending`;
      } else if (act === "rejectPending") {
        url = `/api/intelligence/voice/reject-pending`;
      } else if (act === "rederive") {
        url = `/api/intelligence/voice/derive`;
      } else if (act === "pin") {
        url = `/api/intelligence/voice/pin`;
        payload = { workspaceId, pinned: extra.pinned };
      } else {
        throw new Error(`Unknown voice action: ${act}`);
      }
      const r = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error ?? "Voice update failed");
      setNotice(
        act === "acceptPending" ? "Update applied to your voice profile."
        : act === "rejectPending" ? "Proposed update discarded."
        : act === "rederive" ? "Voice re-derived from your content samples."
        : act === "pin" ? (extra.pinned ? "Voice profile locked — the learner won't touch it." : "Voice profile unlocked.")
        : "Voice profile saved.",
      );
      setEditing(false);
      router.refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  function openEdit() {
    const f: Record<string, string> = {};
    for (const m of DIM_META) {
      f[m.key] = m.list ? list(dims[m.key]).join(", ") : str(dims[m.key]);
    }
    setForm(f);
    setEditing(true);
  }

  function saveEdit() {
    const dimensions: Record<string, unknown> = {};
    for (const m of DIM_META) {
      const v = (form[m.key] ?? "").trim();
      dimensions[m.key] = m.list ? v.split(",").map((s) => s.trim()).filter(Boolean) : v;
    }
    void action("update", { dimensions });
  }

  const samples = Array.isArray(derived.samples) ? derived.samples.length : 0;

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

      {/* Pending learner update — reviewable diff */}
      {pending && Object.keys(pendingDims).length > 0 && (
        <section className="rounded-lg border border-brand-600/30 bg-brand-50/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[14px] font-semibold text-stone-900">
              Review pending update
              <span className="ml-2 font-normal text-stone-500">
                proposed {pending.proposedAt ? new Date(pending.proposedAt).toLocaleDateString() : "recently"}
              </span>
            </h2>
            {canEdit && (
              <div className="flex gap-2">
                <button type="button" onClick={() => action("rejectPending")} disabled={busy} className={btnGhost}>
                  <X size={14} /> Reject
                </button>
                <button type="button" onClick={() => action("acceptPending")} disabled={busy} className={btnPrimary}>
                  <Check size={14} /> Approve
                </button>
              </div>
            )}
          </div>
          {pending.rationale && <p className="mt-1 text-[12.5px] text-stone-600">{pending.rationale}</p>}
          <div className="mt-3 space-y-2">
            {DIM_META.filter((m) => {
              const v = pendingDims[m.key];
              return m.list ? list(v).length > 0 : str(v) !== "";
            }).map((m) => (
              <div key={m.key} className="grid gap-2 rounded-md border border-stone-200 bg-white p-2.5 md:grid-cols-2">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Current — {m.label}</p>
                  <p className="mt-0.5 text-[12.5px] text-stone-600">
                    {m.list ? list(dims[m.key]).join(", ") || "—" : str(dims[m.key]) || "—"}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-brand-700">Proposed — {m.label}</p>
                  <p className="mt-0.5 text-[12.5px] font-medium text-stone-900">
                    {m.list ? list(pendingDims[m.key]).join(", ") : str(pendingDims[m.key])}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Profile */}
      <section className="rounded-lg border border-stone-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-full bg-brand-50 text-brand-700">
              <Megaphone size={16} />
            </span>
            <div>
              <h2 className="text-[14px] font-semibold text-stone-900">Brand voice</h2>
              <p className="text-[12px] text-stone-500">
                {profile
                  ? `Derived from ${samples} sample${samples === 1 ? "" : "s"} · ${Math.round(profile.confidence * 100)}% confidence`
                  : "No voice profile yet — re-derive from your content or describe it below."}
              </p>
            </div>
          </div>
          {canEdit && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => action("rederive")}
                disabled={busy}
                className={btnGhost}
                title="Re-derive the voice from your content samples"
              >
                <RefreshCw size={14} /> Re-derive from samples
              </button>
              <button type="button" onClick={openEdit} disabled={busy} className={btnGhost} aria-label="Edit voice profile">
                <Pencil size={14} />
              </button>
              <button
                type="button"
                onClick={() => action("pin", { pinned: !profile?.pinnedByUser })}
                disabled={busy || !profile}
                className={btnGhost}
                title={profile?.pinnedByUser ? "Unlock — let the learner refine it" : "Lock — the learner won't touch it"}
              >
                {profile?.pinnedByUser ? <Lock size={14} /> : <LockOpen size={14} />}
                {profile?.pinnedByUser ? "Locked" : "Lock"}
              </button>
            </div>
          )}
        </div>

        <dl className="mt-4 grid gap-3 md:grid-cols-2">
          {DIM_META.map((m) => {
            const v = m.list ? list(dims[m.key]) : str(dims[m.key]);
            const empty = m.list ? v.length === 0 : !v;
            return (
              <div key={m.key} className="rounded-md border border-stone-100 bg-stone-50/50 p-3">
                <dt className="text-[11px] font-medium uppercase tracking-wide text-stone-400">{m.label}</dt>
                <dd className="mt-1 text-[13px] text-stone-800">
                  {empty ? (
                    <span className="italic text-stone-400">Not set</span>
                  ) : m.list ? (
                    <span className="flex flex-wrap gap-1">
                      {(v as string[]).map((w) => (
                        <Chip key={w} tone="violet">{w}</Chip>
                      ))}
                    </span>
                  ) : (
                    v as string
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
        {profile?.pinnedByUser && (
          <p className="mt-3 flex items-center gap-1.5 text-[12px] text-stone-500">
            <Lock size={12} /> Locked by you — consolidation proposals arrive as reviewable diffs instead of applying directly.
          </p>
        )}
      </section>

      {editing && (
        <Modal title="Edit brand voice" onClose={() => setEditing(false)}>
          {DIM_META.map((m) => (
            <div key={m.key} className="mb-3">
              <label className="mb-1 block text-[12.5px] font-medium text-stone-700">
                {m.label}{m.list && <span className="font-normal text-stone-400"> — comma separated</span>}
              </label>
              {m.list || m.key === "rhythm" ? (
                <input value={form[m.key] ?? ""} onChange={(e) => setForm({ ...form, [m.key]: e.target.value })} className={`${inputCls} w-full`} />
              ) : (
                <textarea value={form[m.key] ?? ""} onChange={(e) => setForm({ ...form, [m.key]: e.target.value })} rows={2} className={`${inputCls} w-full`} />
              )}
            </div>
          ))}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditing(false)} className={btnGhost}>Cancel</button>
            <button type="button" onClick={saveEdit} disabled={busy} className={btnPrimary}>
              <Check size={14} /> Save voice
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
