// Marketr — nurture sequence builder: name/description/status/dailyCap +
// steps editor (add/remove/reorder, channel, delay, template with
// placeholder chips).
"use client";

import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  FileText,
  GripVertical,
  Mail,
  Mailbox,
  MessageCircle,
  Phone,
  Plus,
  Trash2,
} from "lucide-react";
import type { NurtureSequence, NurtureStep } from "./types";
import { Chip, inputCls, btnPrimary, btnSecondary } from "./ui";

const PLACEHOLDERS = ["firstName", "company", "email", "phone", "unsubscribeUrl"] as const;
const MAIL_PLACEHOLDERS = ["firstName", "company", "addressLine1", "city", "state", "zip", "qrSlug"] as const;

const CHANNELS = [
  { value: "sms", label: "SMS", Icon: MessageCircle },
  { value: "email", label: "Email", Icon: Mail },
  { value: "voice", label: "Voice", Icon: Phone },
  { value: "postcard", label: "Postcard", Icon: Mailbox },
  { value: "letter", label: "Letter", Icon: FileText },
] as const;

function isMailChannelValue(channel: string): boolean {
  return channel === "postcard" || channel === "letter";
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** In-home window preview for a mail step (mailDate + 2d / + 7d transit). */
function inHomePreview(delayDays: number): string {
  const mail = new Date(Date.now() + Math.max(0, delayDays) * 86_400_000);
  const start = new Date(mail.getTime() + 2 * 86_400_000);
  const end = new Date(mail.getTime() + 7 * 86_400_000);
  return `Mails ${fmtDate(mail)} → in-home ${fmtDate(start)}–${fmtDate(end)}`;
}

function blankStep(): NurtureStep {
  return { channel: "sms", delayMinutes: 60, template: "" };
}

interface StudioCreativeOpt {
  id: string;
  name: string;
  size: string;
  status: string;
}

/** Studio print creatives for the mail-step creative picker (T2). */
function useStudioCreatives() {
  const [creatives, setCreatives] = useState<StudioCreativeOpt[] | null>(null);
  useEffect(() => {
    fetch("/api/studio/creatives?channelTemplate=print&formatTrack=addressed")
      .then((r) => (r.ok ? r.json() : { creatives: [] }))
      .then((d) => setCreatives(Array.isArray(d.creatives) ? d.creatives : []))
      .catch(() => setCreatives([]));
  }, []);
  return creatives;
}

export function SequenceBuilder({
  initial,
  saving,
  error,
  onSave,
  onCancel,
}: {
  initial?: NurtureSequence | null;
  saving: boolean;
  error: string | null;
  onSave: (data: {
    name: string;
    description?: string;
    steps: NurtureStep[];
    status: string;
    dailyCap: number | null;
  }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [status, setStatus] = useState<NurtureSequence["status"]>(initial?.status ?? "draft");
  const [dailyCap, setDailyCap] = useState(initial?.dailyCap != null ? String(initial.dailyCap) : "");
  const [steps, setSteps] = useState<NurtureStep[]>(
    initial?.steps?.length ? initial.steps.map((s) => ({ ...s })) : [blankStep()],
  );
  const studioCreatives = useStudioCreatives();

  const updateStep = (i: number, patch: Partial<NurtureStep>) =>
    setSteps((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  const moveStep = (i: number, dir: -1 | 1) =>
    setSteps((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const insertPlaceholder = (i: number, ph: string) =>
    updateStep(i, { template: (steps[i].template ?? "") + `{{${ph}}}` });

  const valid =
    name.trim().length > 0 &&
    steps.length > 0 &&
    steps.every((s) => s.template.trim().length > 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-[12px] font-medium text-stone-600">Name</label>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. New lead 7-day drip" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-[12px] font-medium text-stone-600">Status</label>
            <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value as NurtureSequence["status"])}>
              <option value="draft">Draft</option>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="archived">Archived</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium text-stone-600">Daily cap <span className="text-stone-400">(optional)</span></label>
            <input
              className={inputCls}
              type="number"
              min={1}
              value={dailyCap}
              onChange={(e) => setDailyCap(e.target.value)}
              placeholder="No cap"
            />
          </div>
        </div>
      </div>
      <div>
        <label className="mb-1 block text-[12px] font-medium text-stone-600">Description</label>
        <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this sequence is for…" />
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <label className="text-[12px] font-medium text-stone-600">Steps ({steps.length})</label>
          <button className={btnSecondary} onClick={() => setSteps((p) => [...p, blankStep()])}>
            <Plus size={14} /> Add step
          </button>
        </div>
        <div className="space-y-2">
          {steps.map((step, i) => (
            <div key={i} className="rounded-[10px] border border-stone-200 bg-stone-50/60 p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-1 text-[12px] font-semibold text-stone-500">
                  <GripVertical size={13} className="text-stone-300" />
                  Step {i + 1}
                </span>
                <div className="flex flex-wrap rounded-md border border-stone-300 bg-white p-px">
                  {CHANNELS.map(({ value, label, Icon }) => (
                    <button
                      key={value}
                      onClick={() => updateStep(i, { channel: value })}
                      className={`flex items-center gap-1 rounded px-2 py-1 text-[12px] font-medium ${
                        step.channel === value ? "bg-violet-600 text-white" : "text-stone-600 hover:bg-stone-100"
                      }`}
                    >
                      <Icon size={12} /> {label}
                    </button>
                  ))}
                </div>
                {isMailChannelValue(step.channel) ? (
                  <label className="flex items-center gap-1.5 text-[12px] text-stone-600">
                    Delay
                    <input
                      type="number"
                      min={0}
                      value={step.delayDays ?? 1}
                      onChange={(e) => updateStep(i, { delayDays: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                      className="w-20 rounded-md border border-stone-300 bg-white px-2 py-1 text-[12px] focus:border-violet-500 focus:outline-none"
                    />
                    days
                  </label>
                ) : (
                  <label className="flex items-center gap-1.5 text-[12px] text-stone-600">
                    Delay
                    <input
                      type="number"
                      min={0}
                      value={step.delayMinutes}
                      onChange={(e) => updateStep(i, { delayMinutes: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                      className="w-20 rounded-md border border-stone-300 bg-white px-2 py-1 text-[12px] focus:border-violet-500 focus:outline-none"
                    />
                    min
                  </label>
                )}
                <div className="ml-auto flex items-center gap-1">
                  <button
                    className="rounded p-1 text-stone-400 hover:bg-stone-200 hover:text-stone-700 disabled:opacity-30"
                    disabled={i === 0}
                    onClick={() => moveStep(i, -1)}
                    title="Move up"
                  >
                    <ArrowUp size={14} />
                  </button>
                  <button
                    className="rounded p-1 text-stone-400 hover:bg-stone-200 hover:text-stone-700 disabled:opacity-30"
                    disabled={i === steps.length - 1}
                    onClick={() => moveStep(i, 1)}
                    title="Move down"
                  >
                    <ArrowDown size={14} />
                  </button>
                  <button
                    className="rounded p-1 text-stone-400 hover:bg-red-100 hover:text-red-700 disabled:opacity-30"
                    disabled={steps.length === 1}
                    onClick={() => setSteps((p) => p.filter((_, j) => j !== i))}
                    title="Remove step"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              {isMailChannelValue(step.channel) ? (
                <div className="mb-2 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      className={`${inputCls} max-w-[300px]`}
                      value={step.creativeId ?? ""}
                      onChange={(e) => updateStep(i, { creativeId: e.target.value || undefined })}
                      title="Studio creative (optional — ad-hoc copy creative is hash-bound automatically)"
                    >
                      <option value="">Ad-hoc copy creative (auto)</option>
                      {(studioCreatives ?? []).map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} — {c.size} ({c.status})
                        </option>
                      ))}
                    </select>
                    <span className="text-[12px] text-stone-500">
                      {inHomePreview(step.delayDays ?? 1)}
                      <span className="text-stone-400"> · USPS transit 2–7 days · approval binds creative + spend</span>
                    </span>
                  </div>
                  <p className="text-[11px] text-stone-400">
                    Recipient needs a physical address on file (CRM custom field <span className="font-mono">address</span>) and mail opt-in. Unverifiable addresses are quarantined, never mailed.
                  </p>
                </div>
              ) : null}
              {step.channel === "email" ? (
                <input
                  className={`${inputCls} mb-2`}
                  value={step.subject ?? ""}
                  onChange={(e) => updateStep(i, { subject: e.target.value })}
                  placeholder="Subject (email only)"
                />
              ) : null}
              <textarea
                className={`${inputCls} min-h-[76px] font-mono text-[12px]`}
                value={step.template}
                onChange={(e) => updateStep(i, { template: e.target.value })}
                placeholder={
                  step.channel === "email"
                    ? "Hi {{firstName}}, … ({{unsubscribeUrl}} is appended for compliance)"
                    : isMailChannelValue(step.channel)
                      ? "Hi {{firstName}}, … ({{addressLine1}}, {{city}} merge from the lead's address; {{qrSlug}} for the tracking QR)"
                      : "Hi {{firstName}}, …"
                }
              />
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-stone-400">Insert:</span>
                {(isMailChannelValue(step.channel) ? MAIL_PLACEHOLDERS : PLACEHOLDERS).map((ph) => (
                  <button key={ph} onClick={() => insertPlaceholder(i, ph)} title={`Insert {{${ph}}}`}>
                    <Chip tone="violet">{`{{${ph}}}`}</Chip>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {error ? <p className="text-[13px] text-red-600">{error}</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-stone-200 pt-3">
        <button className={btnSecondary} onClick={onCancel}>Cancel</button>
        <button
          className={btnPrimary}
          disabled={!valid || saving}
          onClick={() =>
            onSave({
              name: name.trim(),
              description: description.trim() || undefined,
              steps,
              status,
              dailyCap: dailyCap ? Math.max(1, Math.floor(Number(dailyCap))) : null,
            })
          }
        >
          {saving ? "Saving…" : initial ? "Save changes" : "Create sequence"}
        </button>
      </div>
    </div>
  );
}
