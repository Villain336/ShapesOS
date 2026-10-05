// Marketr CRM — leave request modal (Phase 17 slice 5).
// Creates a free leave request in "requested" status; a manager's
// approval gates the approve step later. No gate at creation.

"use client";

import { useState } from "react";
import { Loader2, X } from "lucide-react";
import type { OpsTeamMember } from "./TeamTab";
import { backdropCls, btnGhost, btnPrimary, errorBoxCls, inputCls, modalWrapCls } from "./ui";

export function LeaveRequestModal({
  members,
  onClose,
  onCreated,
}: {
  members: OpsTeamMember[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [memberId, setMemberId] = useState("");
  const [type, setType] = useState<"vacation" | "sick" | "personal">("vacation");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!memberId) {
      setError("Choose the team member.");
      return;
    }
    if (!startDate || !endDate) {
      setError("Both dates are required.");
      return;
    }
    if (endDate < startDate) {
      setError("End date must be on or after the start date.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/ops/leave-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId, type, startDate, endDate }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Failed to request leave.");
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to request leave.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className={backdropCls} onClick={onClose} aria-hidden />
      <div className={modalWrapCls}>
        <div className="flex items-start justify-between border-b border-line px-5 py-4">
          <h3 className="text-lg font-bold tracking-tight text-ink">Request leave</h3>
          <button onClick={onClose} className="rounded-md p-1.5 text-subtle hover:bg-hover-paper hover:text-ink" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="flex flex-col gap-4 px-5 py-4">
          {error && (
            <div className={errorBoxCls}>
              {error}
            </div>
          )}
          <label className="block">
            <span className="mb-1 block text-[12px] font-semibold text-ink">Team member *</span>
            <select
              value={memberId}
              onChange={(e) => setMemberId(e.target.value)}
              className={`${inputCls} w-full`}
            >
              <option value="">Select…</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.title ? ` · ${m.title}` : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-3 gap-3">
            <label className="block">
              <span className="mb-1 block text-[12px] font-semibold text-ink">Type</span>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as typeof type)}
                className={`${inputCls} w-full`}
              >
                <option value="vacation">Vacation</option>
                <option value="sick">Sick</option>
                <option value="personal">Personal</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] font-semibold text-ink">Start *</span>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className={`${inputCls} w-full`}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] font-semibold text-ink">End *</span>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className={`${inputCls} w-full`}
              />
            </label>
          </div>
          <p className="text-[12px] text-muted">
            Goes out as a request. A manager approves it — that approval is gated and recorded.
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className={btnGhost}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={saving}
              className={btnPrimary}
            >
              {saving && <Loader2 size={14} className="animate-spin" />} Request
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
