// Marketr — Settings → Agents → Memory tab (Phase 13B, worker 5).
// "What I've learned about you": lessons (from memory_learnings — retire,
// never delete), preference profile, pause-learning toggle, JSON export,
// and the onboarding empty-state (3 quick questions seed preferences when
// none exist — no onboarding flow exists in the repo, so the surface IS
// the onboarding hook).

"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Brain,
  Check,
  Download,
  Pause,
  Pencil,
  Pin,
  Play,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
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
} from "../../substrate/ui";
import type { LessonRow } from "./page";

interface PrefRow {
  id: string;
  key: string;
  value: unknown;
  confidence: number;
  pinned: boolean;
  origin: string;
  validAt: string;
}

const PREF_LABELS: Record<string, string> = {
  voice_style: "Tone of voice",
  risk_tolerance: "Risk tolerance",
  detail_level: "Detail level",
  channels: "Channels",
  definition_of_good: "Definition of good",
  learning_paused: "Learning paused",
};

function prettyKey(key: string) {
  return PREF_LABELS[key] ?? key.replace(/_/g, " ");
}

function prettyValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return JSON.stringify(value);
}

function confidenceTone(c: number | null): "green" | "amber" | "red" | "slate" {
  if (c == null) return "slate";
  if (c >= 0.8) return "green";
  if (c >= 0.5) return "amber";
  return "red";
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function Toggle({
  on,
  onChange,
  disabled,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40 ${
        on ? "bg-brand-600" : "bg-stone-300"
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
          on ? "left-[18px]" : "left-0.5"
        }`}
      />
    </button>
  );
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
      <div className="relative w-full max-w-lg rounded-lg border border-stone-200 bg-white p-5 shadow-xl">
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

export default function MemoryTab({
  workspaceId,
  lessons,
  preferences,
  paused,
  canEdit,
}: {
  workspaceId: string;
  lessons: LessonRow[];
  preferences: PrefRow[];
  paused: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [showRetired, setShowRetired] = useState(false);
  const [editing, setEditing] = useState<LessonRow | null>(null);
  const [editText, setEditText] = useState("");
  const [editAction, setEditAction] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<LessonRow | null>(null);
  const [editPref, setEditPref] = useState<PrefRow | null>(null);
  const [prefValue, setPrefValue] = useState("");
  const [prefPinned, setPrefPinned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const ws = `workspaceId=${encodeURIComponent(workspaceId)}`;

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return lessons.filter((l) => {
      if (!showRetired && l.retired) return false;
      if (!needle) return true;
      return (
        l.hypothesis.toLowerCase().includes(needle) ||
        l.action.toLowerCase().includes(needle) ||
        l.source.toLowerCase().includes(needle)
      );
    });
  }, [lessons, q, showRetired]);

  const activeCount = lessons.filter((l) => !l.retired).length;

  async function postPref(key: string, value: unknown, pinned = false) {
    const r = await fetch(`/api/agents/preferences?${ws}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, key, value, pinned, origin: "user_told", confidence: 1 }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Preference save failed");
  }

  async function togglePaused(next: boolean) {
    setBusy(true);
    try {
      await postPref("learning_paused", next);
      router.refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Toggle failed");
    } finally {
      setBusy(false);
    }
  }

  // DELETE = retire via the invalidate API. Per the DATA-MODEL contract
  // lessons are never hard-deleted; invalidation removes them from active
  // recall (no ghost recall) while history stays auditable.
  async function deleteLesson(lesson: LessonRow) {
    setBusy(true);
    try {
      const r = await fetch(`/api/substrate/memory/learnings/${lesson.id}?${ws}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, invalidate: true, reason: "Retired from Settings → Agents → Memory" }),
      });
      if (!r.ok) throw new Error("Retire failed");
      setConfirmDelete(null);
      setNotice("Lesson retired — it will no longer be recalled.");
      router.refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  // Edit = retire the old row + record the corrected one (memory is
  // immutable; supersede, never rewrite).
  async function saveEdit() {
    if (!editing || !editText.trim()) return;
    setBusy(true);
    try {
      const r1 = await fetch(`/api/substrate/memory/learnings/${editing.id}?${ws}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, invalidate: true, reason: "Superseded by user edit" }),
      });
      if (!r1.ok) throw new Error("Could not retire the old lesson");
      const r2 = await fetch(`/api/substrate/memory/learnings?${ws}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          hypothesis: editText.trim(),
          action: editAction.trim() || "user correction",
          result: editing.result,
        }),
      });
      if (!r2.ok) throw new Error("Could not save the edited lesson");
      setEditing(null);
      setNotice("Lesson updated.");
      router.refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Edit failed");
    } finally {
      setBusy(false);
    }
  }

  async function savePref() {
    if (!editPref) return;
    setBusy(true);
    try {
      let value: unknown = prefValue;
      const trimmed = prefValue.trim();
      if (trimmed === "true") value = true;
      else if (trimmed === "false") value = false;
      else if (trimmed !== "" && !Number.isNaN(Number(trimmed))) value = Number(trimmed);
      else if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length > 1) {
        try { value = JSON.parse(trimmed); } catch { value = prefValue; }
      }
      await postPref(editPref.key, value, prefPinned);
      setEditPref(null);
      setNotice("Preference saved.");
      router.refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  function exportJson() {
    const payload = {
      exportedAt: new Date().toISOString(),
      lessons: lessons.filter((l) => !l.retired),
      preferences: preferences.map((p) => ({
        key: p.key,
        value: p.value,
        confidence: p.confidence,
        pinned: p.pinned,
        origin: p.origin,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "marketr-agent-memory.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-6">
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

      {/* Learning controls */}
      <section className="flex flex-wrap items-center gap-4 rounded-lg border border-stone-200 bg-white p-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className={`flex size-9 shrink-0 items-center justify-center rounded-full ${paused ? "bg-stone-200 text-stone-500" : "bg-brand-50 text-brand-700"}`}>
            <Brain size={17} />
          </span>
          <div className="min-w-0">
            <p className="text-[13.5px] font-medium text-stone-900">
              Agent learning is {paused ? "paused" : "on"}
            </p>
            <p className="text-[12.5px] text-stone-500">
              {paused
                ? "Agents still use what they learned, but nothing new is recorded."
                : "Every interaction can become a durable lesson. You can inspect, correct, or retire anything below."}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Toggle on={paused} onChange={togglePaused} disabled={!canEdit || busy} label="Pause agent learning" />
          <span className="text-[12.5px] text-stone-500">{paused ? "Paused" : "Learning"}</span>
        </div>
        <button type="button" onClick={exportJson} className={btnGhost}>
          <Download size={14} /> Export
        </button>
      </section>

      {/* Onboarding hook: no preferences yet → 3 quick questions */}
      {preferences.length === 0 && (
        <OnboardingQuestions
          canEdit={canEdit}
          onSeed={async (answers) => {
            setBusy(true);
            try {
              for (const [key, value] of Object.entries(answers)) {
                await postPref(key, value);
              }
              setNotice("Preferences saved — agents will use them from now on.");
              router.refresh();
            } catch (e) {
              setNotice(e instanceof Error ? e.message : "Seeding failed");
            } finally {
              setBusy(false);
            }
          }}
        />
      )}

      {/* Lessons */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[14px] font-semibold text-stone-900">
            What I&apos;ve learned <span className="ml-1 font-normal text-stone-400">{activeCount} active</span>
          </h2>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[12.5px] text-stone-500">
              <input
                type="checkbox"
                checked={showRetired}
                onChange={(e) => setShowRetired(e.target.checked)}
                className="accent-brand-600"
              />
              Show retired
            </label>
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search lessons…"
                className={`${inputCls} w-48 pl-8`}
              />
            </div>
          </div>
        </div>
        <div className={tableShell}>
          <table className="w-full text-[13px]">
            <thead className={theadCls}>
              <tr>
                <th className={thCls}>Lesson</th>
                <th className={`${thCls} w-28`}>Confidence</th>
                <th className={`${thCls} w-28`}>Sources</th>
                <th className={`${thCls} w-24`}>Status</th>
                <th className={`${thCls} w-28`}>Observed</th>
                {canEdit && <th className={`${thCls} w-20 text-right`}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr className={rowCls}>
                  <td colSpan={canEdit ? 6 : 5} className="px-3 py-8 text-center text-stone-500">
                    {lessons.length === 0
                      ? "No lessons yet — they appear here after agents work and the nightly consolidation runs."
                      : "No lessons match your search."}
                  </td>
                </tr>
              )}
              {filtered.map((l) => (
                <tr key={l.id} className={rowCls}>
                  <td className="px-3 py-2.5">
                    <p className="font-medium leading-snug text-stone-900">{l.hypothesis}</p>
                    <p className="mt-0.5 text-[12px] text-stone-500">via {l.action}</p>
                  </td>
                  <td className="px-3 py-2.5">
                    <Chip tone={confidenceTone(l.confidence)}>
                      {l.confidence == null ? "—" : `${Math.round(l.confidence * 100)}%`}
                    </Chip>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <Chip tone="slate">{l.source}</Chip>
                      <span className="text-[12px] text-stone-500" title="Linked source episodes">
                        {l.sourceCount} ref{l.sourceCount === 1 ? "" : "s"}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <Chip tone={l.retired ? "slate" : "green"}>{l.retired ? "retired" : "active"}</Chip>
                  </td>
                  <td className="px-3 py-2.5 text-stone-500">{fmtDate(l.observedAt)}</td>
                  {canEdit && (
                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        {!l.retired && (
                          <button
                            type="button"
                            aria-label="Edit lesson"
                            onClick={() => { setEditing(l); setEditText(l.hypothesis); setEditAction(l.action); }}
                            className="rounded-md p-1.5 text-stone-400 hover:bg-stone-100 hover:text-stone-700"
                          >
                            <Pencil size={14} />
                          </button>
                        )}
                        {!l.retired && (
                          <button
                            type="button"
                            aria-label="Retire lesson"
                            onClick={() => setConfirmDelete(l)}
                            className="rounded-md p-1.5 text-stone-400 hover:bg-red-50 hover:text-red-600"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[12px] text-stone-400">
          Retiring removes a lesson from what agents recall. Retired lessons stay in history for audit — they are never hard-deleted.
        </p>
      </section>

      {/* Preferences */}
      <section>
        <h2 className="mb-2 text-[14px] font-semibold text-stone-900">
          How I should work <span className="ml-1 font-normal text-stone-400">{preferences.length}</span>
        </h2>
        <div className={tableShell}>
          <table className="w-full text-[13px]">
            <thead className={theadCls}>
              <tr>
                <th className={thCls}>Preference</th>
                <th className={thCls}>Value</th>
                <th className={`${thCls} w-28`}>Confidence</th>
                <th className={`${thCls} w-28`}>Origin</th>
                <th className={`${thCls} w-28`}>Updated</th>
                {canEdit && <th className={`${thCls} w-20 text-right`}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {preferences.length === 0 && (
                <tr className={rowCls}>
                  <td colSpan={canEdit ? 6 : 5} className="px-3 py-8 text-center text-stone-500">
                    No preferences yet — answer the three questions above and agents stop asking what they should already know.
                  </td>
                </tr>
              )}
              {preferences.map((p) => (
                <tr key={p.id} className={rowCls}>
                  <td className="px-3 py-2.5">
                    <span className="flex items-center gap-1.5 font-medium text-stone-900">
                      {prettyKey(p.key)}
                      {p.pinned && <Pin size={12} className="text-brand-600" aria-label="Pinned — the learner cannot change this" />}
                    </span>
                  </td>
                  <td className="max-w-[320px] truncate px-3 py-2.5 text-stone-700" title={prettyValue(p.value)}>
                    {prettyValue(p.value)}
                  </td>
                  <td className="px-3 py-2.5">
                    <Chip tone={confidenceTone(p.confidence)}>{Math.round(p.confidence * 100)}%</Chip>
                  </td>
                  <td className="px-3 py-2.5">
                    <Chip tone={p.origin === "user_told" ? "violet" : "slate"}>
                      {p.origin === "user_told" ? "you" : p.origin.replace(/_/g, " ")}
                    </Chip>
                  </td>
                  <td className="px-3 py-2.5 text-stone-500">{fmtDate(p.validAt)}</td>
                  {canEdit && (
                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-end">
                        <button
                          type="button"
                          aria-label={`Edit ${prettyKey(p.key)}`}
                          onClick={() => {
                            setEditPref(p);
                            setPrefValue(typeof p.value === "string" ? p.value : JSON.stringify(p.value ?? ""));
                            setPrefPinned(p.pinned);
                          }}
                          className="rounded-md p-1.5 text-stone-400 hover:bg-stone-100 hover:text-stone-700"
                        >
                          <Pencil size={14} />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Edit lesson modal */}
      {editing && (
        <Modal title="Edit lesson" onClose={() => setEditing(null)}>
          <label className="mb-1 block text-[12.5px] font-medium text-stone-700">Lesson</label>
          <textarea
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            rows={3}
            className={`${inputCls} mb-3 w-full`}
          />
          <label className="mb-1 block text-[12.5px] font-medium text-stone-700">What produced it</label>
          <input value={editAction} onChange={(e) => setEditAction(e.target.value)} className={`${inputCls} mb-4 w-full`} />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditing(null)} className={btnGhost}>Cancel</button>
            <button type="button" onClick={saveEdit} disabled={busy || !editText.trim()} className={btnPrimary}>
              <Check size={14} /> Save
            </button>
          </div>
        </Modal>
      )}

      {/* Delete confirm */}
      {confirmDelete && (
        <Modal title="Retire this lesson?" onClose={() => setConfirmDelete(null)}>
          <p className="mb-1 text-[13px] text-stone-700">{confirmDelete.hypothesis}</p>
          <p className="mb-4 text-[12.5px] text-stone-500">
            Agents will stop recalling it. It stays in history for audit — nothing is hard-deleted.
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setConfirmDelete(null)} className={btnGhost}>Cancel</button>
            <button
              type="button"
              onClick={() => deleteLesson(confirmDelete)}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-red-700 disabled:opacity-40"
            >
              <Trash2 size={14} /> Retire lesson
            </button>
          </div>
        </Modal>
      )}

      {/* Edit preference modal */}
      {editPref && (
        <Modal title={`Edit — ${prettyKey(editPref.key)}`} onClose={() => setEditPref(null)}>
          <label className="mb-1 block text-[12.5px] font-medium text-stone-700">Value</label>
          <textarea value={prefValue} onChange={(e) => setPrefValue(e.target.value)} rows={3} className={`${inputCls} mb-3 w-full`} />
          <label className="mb-4 flex cursor-pointer items-center gap-2 text-[13px] text-stone-700">
            <input type="checkbox" checked={prefPinned} onChange={(e) => setPrefPinned(e.target.checked)} className="accent-brand-600" />
            Pin — the learner may never change this
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditPref(null)} className={btnGhost}>Cancel</button>
            <button type="button" onClick={savePref} disabled={busy} className={btnPrimary}>
              <Check size={14} /> Save
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

const ONBOARD_QUESTIONS = [
  {
    key: "voice_style",
    question: "What tone should agent output use?",
    options: ["Direct and concise", "Warm and friendly", "Formal and precise", "Bold and playful"],
  },
  {
    key: "detail_level",
    question: "How much detail do you want?",
    options: ["Brief — just the essentials", "Balanced", "Thorough — show the work"],
  },
  {
    key: "risk_tolerance",
    question: "How should agents handle judgment calls?",
    options: ["Cautious — ask me first", "Balanced", "Bold — act, tell me after"],
  },
] as const;

function OnboardingQuestions({
  canEdit,
  onSeed,
}: {
  canEdit: boolean;
  onSeed: (answers: Record<string, string>) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const done = ONBOARD_QUESTIONS.every((q) => answers[q.key]);

  return (
    <section className="rounded-lg border border-stone-200 bg-white p-5">
      <div className="flex items-center gap-2">
        <Sparkles size={16} className="text-brand-600" />
        <h2 className="text-[14px] font-semibold text-stone-900">How do you like to work?</h2>
      </div>
      <p className="mt-1 text-[12.5px] text-stone-500">
        Three quick answers seed your preference profile — agents use them immediately instead of learning the hard way.
      </p>
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        {ONBOARD_QUESTIONS.map((q) => (
          <div key={q.key}>
            <p className="mb-2 text-[12.5px] font-medium text-stone-700">{q.question}</p>
            <div className="flex flex-col gap-1.5">
              {q.options.map((opt) => {
                const selected = answers[q.key] === opt;
                return (
                  <button
                    key={opt}
                    type="button"
                    disabled={!canEdit || saving}
                    onClick={() => setAnswers((a) => ({ ...a, [q.key]: opt }))}
                    className={`rounded-md border px-2.5 py-1.5 text-left text-[12.5px] transition disabled:opacity-40 ${
                      selected
                        ? "border-brand-600 bg-brand-50 text-brand-700 font-medium"
                        : "border-stone-200 bg-white text-stone-700 hover:border-stone-300 hover:bg-stone-50"
                    }`}
                  >
                    {opt}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          disabled={!canEdit || !done || saving}
          onClick={async () => { setSaving(true); await onSeed(answers); setSaving(false); }}
          className={btnPrimary}
        >
          {saving ? <Pause size={14} className="animate-pulse" /> : <Play size={14} />}
          Save preferences
        </button>
      </div>
    </section>
  );
}
