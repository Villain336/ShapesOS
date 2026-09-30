// Marketr CRM — Team tab (Phase 17 slice 5: HR essentials).
// Team member directory + leave requests. Operations lives UNDER the CRM
// per Tico's lock. Dense tables + badges, Studio house pattern.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Search, UserRound } from "lucide-react";
import { NewMemberModal } from "./NewMemberModal";
import { LeaveRequestModal } from "./LeaveRequestModal";
import { LeaveDetail } from "./LeaveDetail";

export interface OpsTeamMember {
  id: string;
  name: string;
  title: string | null;
  email: string | null;
  startDate: string | null;
  status: "active" | "inactive";
  createdAt: string;
}

export interface OpsLeaveRequest {
  id: string;
  memberId: string;
  type: "vacation" | "sick" | "personal";
  startDate: string;
  endDate: string;
  status: "requested" | "approved" | "denied" | "taken";
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export const MEMBER_STATUS_META: Record<string, { label: string; tint: string }> = {
  active: { label: "Active", tint: "bg-[var(--brand-50)] text-[var(--brand-700)]" },
  inactive: { label: "Inactive", tint: "bg-stone-100 text-stone-400" },
};

export const LEAVE_STATUS_META: Record<string, { label: string; tint: string }> = {
  requested: { label: "Requested", tint: "bg-amber-100 text-amber-700" },
  approved: { label: "Approved", tint: "bg-[var(--brand-50)] text-[var(--brand-700)]" },
  denied: { label: "Denied", tint: "bg-red-100 text-red-700" },
  taken: { label: "Taken", tint: "bg-stone-200 text-stone-700" },
};

export const LEAVE_TYPE_LABEL: Record<string, string> = {
  vacation: "Vacation",
  sick: "Sick",
  personal: "Personal",
};

export function fmtDate(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function TeamTab() {
  const [members, setMembers] = useState<OpsTeamMember[]>([]);
  const [leaves, setLeaves] = useState<OpsLeaveRequest[]>([]);
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"all" | "active" | "inactive">("all");
  const [leaveStatus, setLeaveStatus] = useState<"all" | "requested" | "approved" | "denied" | "taken">("all");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNewMember, setShowNewMember] = useState(false);
  const [showNewLeave, setShowNewLeave] = useState(false);
  const [selectedLeaveId, setSelectedLeaveId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const mParams = new URLSearchParams({ limit: "200" });
      if (status !== "all") mParams.set("status", status);
      const mr = await fetch(`/api/ops/team-members?${mParams.toString()}`);
      const md = await mr.json();
      if (!mr.ok) throw new Error(md.error ?? "Failed to load team.");
      const mrows = (md.rows ?? []) as OpsTeamMember[];
      setMembers(mrows);

      const lParams = new URLSearchParams({ limit: "200" });
      if (leaveStatus !== "all") lParams.set("status", leaveStatus);
      const lr = await fetch(`/api/ops/leave-requests?${lParams.toString()}`);
      const ld = await lr.json();
      if (!lr.ok) throw new Error(ld.error ?? "Failed to load leave requests.");
      const lrows = (ld.rows ?? []) as OpsLeaveRequest[];
      setLeaves(lrows);

      const ids = [...new Set(lrows.map((x) => x.memberId).filter(Boolean))];
      const names: Record<string, string> = {};
      for (const m of mrows) names[m.id] = m.name;
      const missing = ids.filter((id) => !names[id]);
      if (missing.length > 0) {
        const sr = await fetch("/api/ops/leave-requests/members", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: missing }),
        });
        const sd = await sr.json();
        if (sr.ok) {
          for (const m of (sd.members ?? []) as Array<{ id: string; name: string }>) {
            names[m.id] = m.name;
          }
        }
      }
      setMemberNames(names);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load team.");
    } finally {
      setLoading(false);
    }
  }, [status, leaveStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredMembers = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return members;
    return members.filter(
      (m) =>
        m.name.toLowerCase().includes(needle) ||
        (m.title ?? "").toLowerCase().includes(needle) ||
        (m.email ?? "").toLowerCase().includes(needle),
    );
  }, [members, q]);

  const memberLabel = (id: string) => memberNames[id] ?? "—";
  const selectedLeave = leaves.find((l) => l.id === selectedLeaveId) ?? null;

  return (
    <div>
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-stone-900">Team</h2>
          <p className="mt-0.5 text-[13px] text-stone-500">
            Team directory and time-off requests. Approving leave needs a manager&apos;s approval.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowNewLeave(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-[13px] font-semibold text-stone-700 hover:bg-stone-50"
          >
            <Plus size={14} /> Request leave
          </button>
          <button
            type="button"
            onClick={() => setShowNewMember(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--brand-600)] px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-[var(--brand-700)]"
          >
            <Plus size={14} /> New member
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-10 text-[13px] text-stone-500">
          <Loader2 size={16} className="animate-spin" /> Loading team…
        </div>
      ) : (
        <>
          {/* Members */}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search team…"
                className="w-56 rounded-lg border border-stone-300 bg-white py-1.5 pl-8 pr-2 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-[var(--brand-600)] focus:outline-none"
              />
            </div>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
              className="rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-[13px] text-stone-700 focus:border-[var(--brand-600)] focus:outline-none"
            >
              <option value="all">All members</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>

          {filteredMembers.length === 0 ? (
            <div className="rounded-lg border border-stone-200 bg-stone-50 px-4 py-8 text-center">
              <UserRound size={20} className="mx-auto text-stone-300" />
              <p className="mt-2 text-[13px] font-semibold text-stone-700">No team members yet</p>
              <p className="mt-0.5 text-[13px] text-stone-500">Add your first team member to build the directory.</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
              <table className="crm-table w-full min-w-[680px]">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Title</th>
                    <th>Email</th>
                    <th>Start</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredMembers.map((m) => {
                    const meta = MEMBER_STATUS_META[m.status] ?? MEMBER_STATUS_META.active!;
                    return (
                      <tr key={m.id} className="hover:bg-[var(--brand-50)]/40">
                        <td className="font-semibold text-stone-900">{m.name}</td>
                        <td className="text-stone-700">{m.title ?? "—"}</td>
                        <td className="text-stone-700">{m.email ?? "—"}</td>
                        <td className="text-stone-700 tabular-nums">{fmtDate(m.startDate)}</td>
                        <td>
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${meta.tint}`}>
                            {meta.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Leave requests */}
          <div className="mb-3 mt-8 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[15px] font-bold tracking-tight text-stone-900">Leave requests</h3>
            <select
              value={leaveStatus}
              onChange={(e) => setLeaveStatus(e.target.value as typeof leaveStatus)}
              className="rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-[13px] text-stone-700 focus:border-[var(--brand-600)] focus:outline-none"
            >
              <option value="all">All requests</option>
              <option value="requested">Requested</option>
              <option value="approved">Approved</option>
              <option value="denied">Denied</option>
              <option value="taken">Taken</option>
            </select>
          </div>

          {leaves.length === 0 ? (
            <div className="rounded-lg border border-stone-200 bg-stone-50 px-4 py-8 text-center">
              <p className="text-[13px] font-semibold text-stone-700">No leave requests</p>
              <p className="mt-0.5 text-[13px] text-stone-500">Requests appear here for manager approval.</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
              <table className="crm-table w-full min-w-[680px]">
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Type</th>
                    <th>Dates</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {leaves.map((l) => {
                    const meta = LEAVE_STATUS_META[l.status] ?? LEAVE_STATUS_META.requested!;
                    return (
                      <tr key={l.id} onClick={() => setSelectedLeaveId(l.id)} className="cursor-pointer hover:bg-[var(--brand-50)]/40">
                        <td className="font-semibold text-stone-900">{memberLabel(l.memberId)}</td>
                        <td className="text-stone-700">{LEAVE_TYPE_LABEL[l.type] ?? l.type}</td>
                        <td className="text-stone-700 tabular-nums">
                          {fmtDate(l.startDate)} → {fmtDate(l.endDate)}
                        </td>
                        <td>
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${meta.tint}`}>
                            {meta.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {showNewMember && (
        <NewMemberModal
          onClose={() => setShowNewMember(false)}
          onCreated={() => {
            setShowNewMember(false);
            void load();
          }}
        />
      )}
      {showNewLeave && (
        <LeaveRequestModal
          members={members}
          onClose={() => setShowNewLeave(false)}
          onCreated={() => {
            setShowNewLeave(false);
            void load();
          }}
        />
      )}
      {selectedLeave && (
        <LeaveDetail
          leave={selectedLeave}
          memberName={memberLabel(selectedLeave.memberId)}
          onClose={() => setSelectedLeaveId(null)}
          onChanged={() => {
            setSelectedLeaveId(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
