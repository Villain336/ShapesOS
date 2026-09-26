// Marketr CRM — lead detail slide-over (reference: right detail panel).
"use client";

import { useEffect, useMemo, useState } from "react";
import {
  X, Star, SquareArrowOutUpRight, Pencil, Phone, Mail,
  MessageSquareText, Calendar, NotebookPen, Flag,
} from "lucide-react";
import type { CrmActivity, CrmLead, CrmPipeline, CrmStage } from "./types";
import { SOURCE_LABELS, formatMoney, timeAgo } from "./types";
import { StageBadge, ScoreBar, MiniBars, Avatar } from "./ui";

const ACT_META: Record<string, { label: string; icon: typeof Phone; tint: string }> = {
  created: { label: "Created", icon: Flag, tint: "bg-violet-100 text-violet-700" },
  note: { label: "Note", icon: NotebookPen, tint: "bg-stone-200 text-stone-600" },
  email: { label: "Email", icon: Mail, tint: "bg-blue-100 text-blue-700" },
  call: { label: "Call", icon: Phone, tint: "bg-green-100 text-green-700" },
  sms: { label: "SMS", icon: MessageSquareText, tint: "bg-teal-100 text-teal-700" },
  meeting: { label: "Meeting", icon: Calendar, tint: "bg-amber-100 text-amber-700" },
  stage_change: { label: "Stage", icon: Flag, tint: "bg-violet-100 text-violet-700" },
  score_change: { label: "Score", icon: Flag, tint: "bg-stone-200 text-stone-600" },
  form_submit: { label: "Form", icon: MessageSquareText, tint: "bg-blue-100 text-blue-700" },
  import: { label: "Import", icon: MessageSquareText, tint: "bg-stone-200 text-stone-600" },
};

function weeklyBuckets(activities: CrmActivity[]): number[] {
  const buckets = new Array(8).fill(0);
  const now = Date.now();
  for (const a of activities) {
    const w = Math.floor((now - new Date(a.createdAt).getTime()) / (7 * 86_400_000));
    if (w >= 0 && w < 8) buckets[7 - w] += 1;
  }
  return buckets;
}

export function LeadSlideOver({
  leadId, pipeline, onClose, onChanged,
}: {
  leadId: string;
  pipeline: CrmPipeline;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [lead, setLead] = useState<CrmLead | null>(null);
  const [stages, setStages] = useState<CrmStage[]>(pipeline.stages);
  const [activities, setActivities] = useState<CrmActivity[]>([]);
  const [scoreBreakdown, setScoreBreakdown] = useState<{ score: number; band: string; reasons: string[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [newAct, setNewAct] = useState({ type: "note", body: "" });
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/crm/leads/${leadId}`);
      if (!r.ok) throw new Error("Failed to load lead");
      const d = await r.json();
      setLead(d.lead);
      setStages(d.stages);
      setActivities(d.activities);
      setScoreBreakdown(d.scoreBreakdown);
      setDraft({
        name: d.lead.name, email: d.lead.email ?? "", phone: d.lead.phone ?? "",
        company: d.lead.company ?? "", title: d.lead.title ?? "",
        value: d.lead.valueCents != null ? String(d.lead.valueCents / 100) : "",
        ownerName: d.lead.ownerName ?? "",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [leadId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const buckets = useMemo(() => weeklyBuckets(activities), [activities]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { email: 0, call: 0, meeting: 0, note: 0, sms: 0 };
    for (const a of activities) if (c[a.type] !== undefined) c[a.type]++;
    return c;
  }, [activities]);

  if (loading || !lead) {
    return (
      <>
        <div className="crm-backdrop" onClick={onClose} />
        <div className="crm-slideover items-center justify-center">
          <p className="text-sm text-stone-500">{loading ? "Loading lead…" : error || "Not found"}</p>
        </div>
      </>
    );
  }

  const stage = stages.find((s) => s.id === lead.stage);
  const stageIdx = stages.findIndex((s) => s.id === lead.stage);

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const valueCents = draft.value.trim() === "" ? null : Math.round(Number(draft.value.replace(/[$,]/g, "")) * 100);
      if (valueCents !== null && (!Number.isFinite(valueCents) || valueCents < 0)) {
        throw new Error("Invalid value");
      }
      const r = await fetch(`/api/crm/leads/${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name.trim(),
          email: draft.email.trim() || null,
          phone: draft.phone.trim() || null,
          company: draft.company.trim() || null,
          title: draft.title.trim() || null,
          ownerName: draft.ownerName.trim() || null,
          valueCents,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Save failed");
      setEditing(false);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const postActivity = async () => {
    if (!newAct.body.trim()) return;
    setPosting(true);
    try {
      const r = await fetch(`/api/crm/leads/${lead.id}/activities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: newAct.type, body: newAct.body.trim() }),
      });
      if (!r.ok) throw new Error("Failed to log activity");
      setNewAct({ type: "note", body: "" });
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setPosting(false);
    }
  };

  const toggleStar = async () => {
    const r = await fetch(`/api/crm/leads/${lead.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ starred: !lead.starred }),
    });
    if (r.ok) { await load(); onChanged(); }
  };

  const changeStage = async (stageId: string) => {
    const r = await fetch(`/api/crm/leads/${lead.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: stageId }),
    });
    if (r.ok) { await load(); onChanged(); }
  };

  const setD = (k: string, v: string) => setDraft({ ...draft, [k]: v });
  const inputCls = "crm-input w-full !text-[13px]";

  return (
    <>
      <div className="crm-backdrop" onClick={onClose} />
      <div className="crm-slideover">
        {/* Header */}
        <div className="flex items-start gap-3 border-b border-stone-200 px-5 py-4">
          <Avatar name={lead.name} size={44} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[17px] font-bold text-stone-900">{lead.name}</h2>
            <p className="truncate text-[13px] text-stone-500">
              {[lead.title, lead.company].filter(Boolean).join(" · ") || lead.email || "—"}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={toggleStar}
              className={`crm-btn-ghost !px-2.5 ${lead.starred ? "!text-violet-700 !border-violet-300 !bg-violet-50" : ""}`}
              title={lead.starred ? "Unfollow" : "Follow"}
            >
              <Star size={15} fill={lead.starred ? "currentColor" : "none"} className={lead.starred ? "text-amber-500" : "text-stone-400"} />
              <span className="hidden sm:inline text-[12.5px]">{lead.starred ? "Following" : "Follow"}</span>
            </button>
            <a
              href={`/dashboard/crm?lead=${lead.id}`}
              className="crm-btn-ghost !px-2.5"
              title="Open full view"
            >
              <SquareArrowOutUpRight size={15} />
              <span className="hidden sm:inline text-[12.5px]">Open</span>
            </a>
            <button onClick={onClose} className="rounded-lg p-2 text-stone-400 hover:bg-stone-100 hover:text-stone-700">
              <X size={17} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
              {error}
            </div>
          )}

          {/* Account summary */}
          <div className="mb-2 flex items-center justify-between">
            <h3 className="crm-section-title !mb-0">Lead Details</h3>
            {!editing ? (
              <button className="crm-btn-ghost !py-1 !px-2.5 !text-[12px]" onClick={() => setEditing(true)}>
                <Pencil size={13} /> Edit
              </button>
            ) : (
              <div className="flex gap-2">
                <button className="crm-btn-ghost !py-1 !px-2.5 !text-[12px]" onClick={() => setEditing(false)} disabled={saving}>
                  Cancel
                </button>
                <button className="crm-btn-primary !py-1 !px-2.5 !text-[12px]" onClick={save} disabled={saving}>
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            )}
          </div>
          {editing ? (
            <div className="mb-5 grid grid-cols-2 gap-3">
              {[
                ["name", "Name"], ["email", "Email"], ["phone", "Phone"],
                ["company", "Company"], ["title", "Title"], ["ownerName", "Owner"],
              ].map(([k, label]) => (
                <div key={k}>
                  <label className="crm-label">{label}</label>
                  <input className={inputCls} value={draft[k] ?? ""} onChange={(e) => setD(k, e.target.value)} />
                </div>
              ))}
              <div>
                <label className="crm-label">Value ($)</label>
                <input className={inputCls} value={draft.value ?? ""} onChange={(e) => setD("value", e.target.value)} inputMode="decimal" />
              </div>
              <div>
                <label className="crm-label">Stage</label>
                <select className="crm-select w-full !text-[13px]" value={lead.stage} onChange={(e) => changeStage(e.target.value)}>
                  {stages.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </div>
            </div>
          ) : (
            <dl className="mb-5 grid grid-cols-2 gap-x-4 gap-y-3 rounded-[10px] border border-stone-200 bg-stone-50/60 p-4 sm:grid-cols-3">
              {[
                ["Owner", lead.ownerName ?? "—"],
                ["Source", SOURCE_LABELS[lead.source] ?? lead.source],
                ["Value", formatMoney(lead.valueCents)],
                ["Email", lead.email ?? "—"],
                ["Phone", lead.phone ?? "—"],
                ["Created", new Date(lead.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">{k}</dt>
                  <dd className="mt-0.5 truncate text-[13px] font-medium text-stone-800" title={String(v)}>{v}</dd>
                </div>
              ))}
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">Stage</dt>
                <dd className="mt-1"><StageBadge label={stage?.label ?? lead.stage} color={stage?.color ?? "gray"} /></dd>
              </div>
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">Score</dt>
                <dd className="mt-1"><ScoreBar score={lead.score} /></dd>
              </div>
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">Last touch</dt>
                <dd className="mt-0.5 text-[13px] font-medium text-stone-800">{timeAgo(lead.lastActivityAt)}</dd>
              </div>
            </dl>
          )}

          {/* Pipeline health */}
          <h3 className="crm-section-title">Pipeline Health</h3>
          <div className="mb-5 rounded-[10px] border border-stone-200 p-4">
            <div className="flex items-center gap-4">
              <div className="text-[34px] font-bold tabular-nums text-stone-900">{lead.score}</div>
              <div className="flex-1">
                <div className="mb-1.5 flex gap-1">
                  {stages.map((s, i) => (
                    <div
                      key={s.id}
                      className="h-2 flex-1 rounded-full"
                      style={{ background: i <= stageIdx ? "#7c3aed" : "#e7e5e4" }}
                      title={s.label}
                    />
                  ))}
                </div>
                <p className="text-[12px] text-stone-500">
                  Stage {stageIdx + 1} of {stages.length} — {stage?.label}
                </p>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <div className="rounded-lg bg-stone-100 px-3 py-2">
                <div className="text-[16px] font-bold tabular-nums">{activities.length}</div>
                <div className="text-[11px] text-stone-500">Touchpoints</div>
              </div>
              <div className="rounded-lg bg-stone-100 px-3 py-2">
                <div className="text-[16px] font-bold tabular-nums">{formatMoney(lead.valueCents)}</div>
                <div className="text-[11px] text-stone-500">Est. value</div>
              </div>
              <div className="rounded-lg bg-violet-50 px-3 py-2">
                <div className="text-[16px] font-bold tabular-nums text-violet-700">
                  {formatMoney(lead.valueCents != null ? Math.round(lead.valueCents * lead.score / 100) : null)}
                </div>
                <div className="text-[11px] text-stone-500">Weighted</div>
              </div>
            </div>
          </div>

          {/* Activity trend */}
          <h3 className="crm-section-title">Activity Trend</h3>
          <div className="mb-5 rounded-[10px] border border-stone-200 p-4">
            <div className="flex items-center gap-4">
              <MiniBars data={buckets} />
              <div className="text-[26px] font-bold tabular-nums text-stone-900">
                {buckets.reduce((a, b) => a + b, 0)}
                <span className="ml-1 text-[12px] font-medium text-stone-500">8 wks</span>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-5 gap-2">
              {[
                ["Emails", counts.email], ["Calls", counts.call], ["Meetings", counts.meeting],
                ["SMS", counts.sms], ["Notes", counts.note],
              ].map(([k, v]) => (
                <div key={k as string} className="rounded-lg bg-stone-100 px-2 py-1.5 text-center">
                  <div className="text-[14px] font-bold tabular-nums">{v as number}</div>
                  <div className="text-[10.5px] text-stone-500">{k as string}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Score detail */}
          {scoreBreakdown && (
            <>
              <h3 className="crm-section-title">Score Detail</h3>
              <ul className="mb-5 space-y-1 rounded-[10px] border border-stone-200 p-3">
                {scoreBreakdown.reasons.map((r, i) => (
                  <li key={i} className="text-[12.5px] text-stone-600">· {r}</li>
                ))}
              </ul>
            </>
          )}

          {/* Timeline */}
          <h3 className="crm-section-title">Timeline</h3>
          <div className="mb-3 flex gap-2">
            <select
              className="crm-select !py-[6px] !text-[12.5px]"
              value={newAct.type}
              onChange={(e) => setNewAct({ ...newAct, type: e.target.value })}
            >
              <option value="note">Note</option>
              <option value="call">Call</option>
              <option value="email">Email</option>
              <option value="sms">SMS</option>
              <option value="meeting">Meeting</option>
            </select>
            <input
              className="crm-input flex-1 !py-[6px] !text-[12.5px]"
              placeholder="Log a touchpoint…"
              value={newAct.body}
              onChange={(e) => setNewAct({ ...newAct, body: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") postActivity(); }}
            />
            <button className="crm-btn-primary !py-[6px] !text-[12.5px]" onClick={postActivity} disabled={posting || !newAct.body.trim()}>
              Log
            </button>
          </div>
          <ol className="space-y-2.5 pb-6">
            {activities.map((a) => {
              const m = ACT_META[a.type] ?? ACT_META.note;
              const Icon = m.icon;
              return (
                <li key={a.id} className="flex gap-2.5">
                  <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${m.tint}`}>
                    <Icon size={14} />
                  </span>
                  <div className="min-w-0 flex-1 rounded-lg border border-stone-200 bg-white px-3 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[12px] font-semibold text-stone-700">{m.label}</span>
                      <span className="shrink-0 text-[11px] text-stone-400">
                        {timeAgo(a.createdAt)}{a.actor ? ` · ${a.actor}` : ""}
                      </span>
                    </div>
                    {a.body && <p className="mt-0.5 whitespace-pre-wrap text-[13px] text-stone-600">{a.body}</p>}
                  </div>
                </li>
              );
            })}
            {activities.length === 0 && (
              <p className="py-4 text-center text-[13px] text-stone-400">No activity yet.</p>
            )}
          </ol>
        </div>
      </div>
    </>
  );
}
