// Marketr — Legal/Compliance slice 2: deadlines view (client).
// The tenant's computed deadlines with escalation tiers, plus the
// "date needed" queue: obligations they own but haven't put on the calendar.
// Guardrail: a deadline only gets a date from the tenant's own input — the
// UI never renders a guessed date, only "date needed".
// Agentic OS: white cards radius-lg, pills for pressables, tokens only,
// Lucide icons only, sentence case, monochrome urgency pills (the status
// color+shape language is reserved for genuine agent states).

"use client";

import { useState } from "react";
import {
  CalendarClock,
  CalendarDays,
  CalendarX,
  CheckCircle2,
  Clock,
  EyeOff,
  Info,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  RECURRENCES,
  RECURRENCE_LABELS,
  type DeadlineRecurrence,
  type EscalationTier,
} from "@/lib/legal/deadlines";

export interface DeadlineView {
  id: string;
  templateKey: string;
  title: string;
  dueDate: string | null;
  recurrence: DeadlineRecurrence;
  source: "tenant_set" | "computed";
  status: "open" | "done" | "dismissed";
  note: string | null;
  tier: EscalationTier | null;
  daysUntilDue: number | null;
}

export interface NeedsDateView {
  templateKey: string;
  title: string;
  category: string;
  renewalCadence: string | null;
}

const TIER_META: Record<EscalationTier | "ontrack", { label: string; icon: typeof Clock }> = {
  overdue: { label: "Overdue", icon: TriangleAlert },
  due_7: { label: "Due in 7 days", icon: Clock },
  due_30: { label: "Due in 30 days", icon: CalendarClock },
  due_90: { label: "Due in 90 days", icon: CalendarDays },
  date_needed: { label: "Date needed", icon: CalendarX },
  ontrack: { label: "On track", icon: CheckCircle2 },
};

const SOURCE_LABELS: Record<DeadlineView["source"], string> = {
  tenant_set: "Date set by you",
  computed: "Computed from renewal cadence",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function toDateInputValue(iso: string | null): string {
  if (!iso) return new Date().toISOString().slice(0, 10);
  return new Date(iso).toISOString().slice(0, 10);
}

function daysText(days: number | null): string | null {
  if (days === null) return null;
  if (days < 0) return `${-days} ${-days === 1 ? "day" : "days"} overdue`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due in ${days} days`;
}

function TierPill({ tier }: { tier: EscalationTier | null }) {
  const key = tier ?? "ontrack";
  const meta = TIER_META[key];
  const Icon = meta.icon;
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-canvas px-3 py-1 text-[13px] font-semibold">
      <Icon size={13} />
      {meta.label}
    </span>
  );
}

function DateForm({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  initial: { dueDate: string | null; recurrence: DeadlineRecurrence };
  busy: boolean;
  onSave: (draft: { dueDate: string | null; recurrence: DeadlineRecurrence }) => void;
  onCancel: () => void;
}) {
  const [date, setDate] = useState(toDateInputValue(initial.dueDate));
  const [useDate, setUseDate] = useState(initial.dueDate !== null);
  const [recurrence, setRecurrence] = useState<DeadlineRecurrence>(initial.recurrence);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md bg-canvas p-3">
      <label className="flex items-center gap-2 text-[14px]">
        <input
          type="checkbox"
          checked={useDate}
          onChange={(e) => setUseDate(e.target.checked)}
          className="h-4 w-4 accent-black"
        />
        Has a due date
      </label>
      {useDate && (
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="h-10 rounded-md border-[1.5px] border-control bg-paper px-3 text-[14px]"
        />
      )}
      <select
        value={recurrence}
        onChange={(e) => setRecurrence(e.target.value as DeadlineRecurrence)}
        className="h-10 rounded-md border-[1.5px] border-control bg-paper px-3 text-[14px]"
        aria-label="Recurrence"
      >
        {RECURRENCES.map((r) => (
          <option key={r} value={r}>
            {RECURRENCE_LABELS[r]}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={busy}
        onClick={() => onSave({ dueDate: useDate && date ? new Date(`${date}T12:00:00Z`).toISOString() : null, recurrence })}
        className="aos-press flex h-10 items-center gap-1.5 rounded-full bg-black px-5 text-[14px] font-semibold text-white disabled:opacity-50"
      >
        {busy && <Loader2 size={14} className="animate-spin" />}
        Save date
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="aos-press flex h-10 items-center gap-1.5 rounded-full px-4 text-[14px] font-semibold text-muted"
      >
        <X size={14} />
        Cancel
      </button>
      {!useDate && (
        <p className="w-full text-[13px] text-muted">
          Leaving this unchecked keeps it as "date needed" — dates are never guessed.
        </p>
      )}
    </div>
  );
}

export function DeadlinesView({
  deadlines,
  needsDate,
  disclaimer,
  onChanged,
}: {
  deadlines: DeadlineView[];
  needsDate: NeedsDateView[];
  disclaimer: string;
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addingKey, setAddingKey] = useState<string | null>(null);

  const open = deadlines.filter((d) => d.status === "open");
  const history = deadlines.filter((d) => d.status !== "open");
  const attentionCount = open.filter((d) => d.tier && d.tier !== "due_90").length;

  async function postDeadline(templateKey: string, draft: { dueDate: string | null; recurrence: DeadlineRecurrence }) {
    setBusyId(`new:${templateKey}`);
    try {
      const res = await fetch("/api/legal/deadlines", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ templateKey, dueDate: draft.dueDate, recurrence: draft.recurrence }),
      });
      if (res.ok) {
        setAddingKey(null);
        onChanged();
      }
    } finally {
      setBusyId(null);
    }
  }

  async function patchDeadline(id: string, body: Record<string, unknown>) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/legal/deadlines/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setEditingId(null);
        onChanged();
      }
    } finally {
      setBusyId(null);
    }
  }

  async function deleteDeadline(id: string) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/legal/deadlines/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (res.ok) onChanged();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3 rounded-lg bg-paper p-4 shadow-hairline">
        <Info size={16} className="mt-0.5 shrink-0" />
        <p className="text-[14px]">{disclaimer}</p>
      </div>

      <p className="text-[13px] text-muted">
        {open.length} on the calendar
        {attentionCount > 0 && ` · ${attentionCount} need${attentionCount === 1 ? "s" : ""} attention`}
        {needsDate.length > 0 && ` · ${needsDate.length} waiting for a date`}
      </p>

      {open.length === 0 && needsDate.length === 0 ? (
        <div className="rounded-lg bg-paper p-8 text-center shadow-hairline">
          <p className="text-[15px] font-semibold">No deadlines yet</p>
          <p className="mt-1 text-sm text-muted">
            Put an obligation on the calendar below and reminders will escalate
            as the date approaches.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {open.map((d) => {
            const busy = busyId === d.id;
            const editing = editingId === d.id;
            return (
              <article key={d.id} className="rounded-lg bg-paper p-4 shadow-hairline">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="min-w-0 flex-1 text-[15px] font-semibold">{d.title}</h3>
                  <TierPill tier={d.tier} />
                </div>
                <p className="mt-1.5 text-[14px] text-muted">
                  {d.dueDate ? (
                    <>
                      {formatDate(d.dueDate)}
                      {daysText(d.daysUntilDue) && (
                        <span className="font-semibold text-ink"> · {daysText(d.daysUntilDue)}</span>
                      )}
                    </>
                  ) : (
                    <span className="font-semibold text-ink">
                      No confirmed date yet — set one to schedule reminders.
                    </span>
                  )}
                </p>
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-canvas px-3 py-1 text-[13px] font-semibold">
                    {RECURRENCE_LABELS[d.recurrence]}
                  </span>
                  <span className="text-[13px] text-muted">{SOURCE_LABELS[d.source]}</span>
                </div>
                {editing ? (
                  <DateForm
                    initial={{ dueDate: d.dueDate, recurrence: d.recurrence }}
                    busy={busy}
                    onSave={(draft) => void patchDeadline(d.id, draft)}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void patchDeadline(d.id, { status: "done" })}
                      className="aos-press flex h-10 items-center gap-1.5 rounded-full bg-black px-5 text-[14px] font-semibold text-white disabled:opacity-50"
                    >
                      {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                      Mark done
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setEditingId(d.id)}
                      className="aos-press flex h-10 items-center gap-1.5 rounded-full bg-paper px-5 text-[14px] font-semibold shadow-hairline disabled:opacity-50"
                    >
                      <Pencil size={14} />
                      {d.dueDate ? "Change date" : "Set date"}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void patchDeadline(d.id, { status: "dismissed" })}
                      className="aos-press flex h-10 items-center gap-1.5 rounded-full px-4 text-[14px] font-semibold text-muted disabled:opacity-50"
                    >
                      <EyeOff size={14} />
                      Dismiss
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {needsDate.length > 0 && (
        <section aria-label="Waiting for a date">
          <h2 className="aos-subheading mb-2">Waiting for a date</h2>
          <p className="mb-3 text-[13px] text-muted">
            These obligations have no deadline on the calendar. Add a date you
            confirm — nothing is scheduled until you do.
          </p>
          <div className="flex flex-col gap-3">
            {needsDate.map((n) => {
              const adding = addingKey === n.templateKey;
              const busy = busyId === `new:${n.templateKey}`;
              return (
                <article key={n.templateKey} className="rounded-lg bg-paper p-4 shadow-hairline">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="min-w-0 flex-1 text-[15px] font-semibold">{n.title}</h3>
                    <TierPill tier="date_needed" />
                  </div>
                  {n.renewalCadence && (
                    <p className="mt-1.5 text-[14px] text-muted">
                      Renewal pattern: {n.renewalCadence}. The reminder recurs
                      only after you anchor it to a real date.
                    </p>
                  )}
                  {adding ? (
                    <DateForm
                      initial={{ dueDate: null, recurrence: "none" }}
                      busy={busy}
                      onSave={(draft) => void postDeadline(n.templateKey, draft)}
                      onCancel={() => setAddingKey(null)}
                    />
                  ) : (
                    <div className="mt-3">
                      <button
                        type="button"
                        onClick={() => setAddingKey(n.templateKey)}
                        className="aos-press flex h-10 items-center gap-1.5 rounded-full bg-black px-5 text-[14px] font-semibold text-white"
                      >
                        <Plus size={14} />
                        Add to calendar
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {history.length > 0 && (
        <section aria-label="Completed">
          <h2 className="aos-subheading mb-2">Completed</h2>
          <div className="flex flex-col gap-2">
            {history.map((d) => {
              const busy = busyId === d.id;
              return (
                <div
                  key={d.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg bg-paper p-3 shadow-hairline"
                >
                  <p className="min-w-0 flex-1 text-[14px] font-semibold">{d.title}</p>
                  <span className="flex items-center gap-1.5 rounded-full bg-canvas px-3 py-1 text-[13px] font-semibold">
                    {d.status === "done" ? <CheckCircle2 size={13} /> : <EyeOff size={13} />}
                    {d.status === "done" ? "Done" : "Dismissed"}
                  </span>
                  {d.dueDate && (
                    <span className="text-[13px] text-muted">{formatDate(d.dueDate)}</span>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void patchDeadline(d.id, { status: "open" })}
                    className="aos-press flex h-9 items-center gap-1.5 rounded-full px-4 text-[13px] font-semibold text-muted disabled:opacity-50"
                  >
                    <RotateCcw size={13} />
                    Reopen
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void deleteDeadline(d.id)}
                    className="aos-press flex h-9 items-center gap-1.5 rounded-full px-4 text-[13px] font-semibold text-failed-text disabled:opacity-50"
                  >
                    <Trash2 size={13} />
                    Delete
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
