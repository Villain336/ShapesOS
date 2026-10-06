// ShapesOS Phase 10 (ops-core) — /dashboard/ops/team: the existing team
// directory + leave (TeamTab), departments, leave balances & policies, and
// a recruiting board (shared Board).

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Briefcase, Building, CalendarDays, Loader2, Plus, UserPlus, UserRound } from "lucide-react";
import { TeamTab } from "@/components/crm/TeamTab";
import {
  Avatar,
  btnGhost,
  btnPrimary,
  chipCls,
  errorBoxCls,
  inputCls,
  labelCls,
  noteBoxCls,
  selectCls,
  tableCls,
  tableWrapCls,
  tdCls,
  thCls,
} from "@/components/crm/ui";
import { Board } from "./Board";
import { usePeople } from "./ProjectsViews";
import { EmptyBlock, LoadingLine, OpsModal, ViewHeader, opsJson, sentence, useOpsList } from "./shared";
import { SubTabs } from "./SubTabs";

interface MemberRow {
  id: string;
  name: string;
  title: string | null;
  departmentId: string | null;
  userId: string | null;
  status: string;
}
interface DepartmentRow {
  id: string;
  name: string;
  managerMemberId: string | null;
}
interface PolicyRow {
  id: string;
  type: string;
  yearlyDays: number;
  carryOverCapDays: number;
  active: boolean;
}
interface BalanceMember {
  memberId: string;
  name: string;
  balances: Array<{ type: string; carriedIn: number; accrued: number; taken: number; adjustments: number; available: number }>;
}
interface OpeningRow {
  id: string;
  title: string;
  departmentId: string | null;
  location: string | null;
  status: string;
}
interface ApplicantRow {
  id: string;
  openingId: string;
  name: string;
  email: string | null;
  stage: string;
  rating: number | null;
  hiredMemberId: string | null;
}

const days = (c: number) => (Math.round(c) / 100).toFixed(c % 100 === 0 ? 0 : 2);

export function TeamWorkspace() {
  const tabs = useMemo(
    () => [
      { id: "people", label: "People and leave", icon: UserRound, render: () => <TeamTab /> },
      { id: "departments", label: "Departments", icon: Building, render: () => <DepartmentsView /> },
      { id: "balances", label: "Leave balances", icon: CalendarDays, render: () => <LeaveBalancesView /> },
      { id: "recruiting", label: "Recruiting", icon: Briefcase, render: () => <RecruitingView /> },
    ],
    [],
  );
  return <SubTabs tabs={tabs} ariaLabel="Team views" />;
}

export function DepartmentsView() {
  const departments = useOpsList<DepartmentRow>("departments");
  const members = useOpsList<MemberRow>("team-members");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { people } = usePeople();

  async function add() {
    setError(null);
    try {
      await opsJson("/api/ops/departments", "POST", { name: name.trim() });
      setName("");
      departments.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the department.");
    }
  }
  async function patch(path: "departments" | "team-members", body: Record<string, unknown>) {
    setError(null);
    try {
      await opsJson(`/api/ops/${path}`, "PATCH", body);
      departments.reload();
      members.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed.");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <ViewHeader title="Departments" hint="Group people and name a manager. Assign people from the table below." />
      <div className="flex flex-wrap items-center gap-2">
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Department name" aria-label="Department name" />
        <button type="button" className={btnPrimary} disabled={!name.trim()} onClick={add}>
          <Plus size={15} /> Add department
        </button>
      </div>
      {(error || departments.error) && <div className={errorBoxCls}>{error ?? departments.error}</div>}
      {departments.loading ? (
        <LoadingLine label="Loading departments…" />
      ) : departments.rows.length === 0 ? (
        <EmptyBlock icon={Building} title="No departments yet" hint="Add one to group your team." />
      ) : (
        <div className={tableWrapCls}>
          <table className={tableCls}>
            <thead>
              <tr>
                <th className={thCls}>Department</th>
                <th className={thCls}>Manager</th>
                <th className={`${thCls} text-right`}>People</th>
              </tr>
            </thead>
            <tbody>
              {departments.rows.map((d) => (
                <tr key={d.id}>
                  <td className={`${tdCls} font-semibold`}>{d.name}</td>
                  <td className={tdCls}>
                    <select className={selectCls} value={d.managerMemberId ?? ""} onChange={(e) => patch("departments", { id: d.id, managerMemberId: e.target.value || null })} aria-label={`Manager of ${d.name}`}>
                      <option value="">No manager</option>
                      {members.rows.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className={`${tdCls} text-right tabular-nums`}>{members.rows.filter((m) => m.departmentId === d.id).length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {members.rows.length > 0 && departments.rows.length > 0 && (
        <div className={tableWrapCls}>
          <table className={tableCls}>
            <thead>
              <tr>
                <th className={thCls}>Person</th>
                <th className={thCls}>Title</th>
                <th className={thCls}>Department</th>
                <th className={thCls}>Signs in as</th>
              </tr>
            </thead>
            <tbody>
              {members.rows.map((m) => (
                <tr key={m.id}>
                  <td className={tdCls}>
                    <span className="inline-flex items-center gap-2">
                      <Avatar name={m.name} size={22} /> {m.name}
                    </span>
                  </td>
                  <td className={`${tdCls} text-muted`}>{m.title ?? "—"}</td>
                  <td className={tdCls}>
                    <select className={selectCls} value={m.departmentId ?? ""} onChange={(e) => patch("team-members", { id: m.id, departmentId: e.target.value || null })} aria-label={`Department of ${m.name}`}>
                      <option value="">None</option>
                      {departments.rows.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className={tdCls}>
                    <select className={selectCls} value={m.userId ?? ""} onChange={(e) => patch("team-members", { id: m.id, userId: e.target.value || null })} aria-label={`Workspace user for ${m.name}`}>
                      <option value="">Not linked</option>
                      {people.map((p) => (
                        <option key={p.userId} value={p.userId}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function LeaveBalancesView() {
  const policies = useOpsList<PolicyRow>("leave-policies");
  const [members, setMembers] = useState<BalanceMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [f, setF] = useState({ type: "vacation", yearlyDays: "20", carry: "5" });
  const [adj, setAdj] = useState({ memberId: "", type: "vacation", days: "", note: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await opsJson("/api/ops/hr/leave-balances", "GET");
      setMembers((data.members ?? []) as BalanceMember[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load balances.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function addPolicy() {
    setError(null);
    try {
      await opsJson("/api/ops/leave-policies", "POST", { type: f.type, yearlyDays: Number(f.yearlyDays), carryOverCapDays: Number(f.carry) });
      policies.reload();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the policy.");
    }
  }
  async function addAdjustment() {
    setError(null);
    setNote(null);
    try {
      await opsJson("/api/ops/leave-ledger", "POST", { memberId: adj.memberId, type: adj.type, year: new Date().getFullYear(), days: Number(adj.days), ...(adj.note.trim() ? { note: adj.note.trim() } : {}) });
      setNote("Adjustment recorded.");
      setAdj({ ...adj, days: "", note: "" });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record the adjustment.");
    }
  }

  const types = policies.rows.filter((p) => p.active).map((p) => p.type);
  return (
    <div className="flex flex-col gap-4">
      <ViewHeader title="Leave balances" hint="Each policy accrues its yearly days month by month; unused days carry into next year up to the cap. Approving leave deducts working days (Mon–Fri)." />
      {error && <div className={errorBoxCls}>{error}</div>}
      {note && <div className={noteBoxCls}>{note}</div>}
      <div className={tableWrapCls}>
        <table className={tableCls}>
          <thead>
            <tr>
              <th className={thCls}>Policy</th>
              <th className={`${thCls} text-right`}>Days per year</th>
              <th className={`${thCls} text-right`}>Carry-over cap</th>
            </tr>
          </thead>
          <tbody>
            {policies.rows.map((p) => (
              <tr key={p.id}>
                <td className={tdCls}>{sentence(p.type)}</td>
                <td className={`${tdCls} text-right tabular-nums`}>{p.yearlyDays}</td>
                <td className={`${tdCls} text-right tabular-nums`}>{p.carryOverCapDays}</td>
              </tr>
            ))}
            {policies.rows.length === 0 && (
              <tr>
                <td className={`${tdCls} text-muted`} colSpan={3}>
                  No leave policies — balances aren’t tracked until you add one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className={labelCls}>Leave type</span>
          <select className={selectCls} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
            {["vacation", "sick", "personal"].filter((t) => !policies.rows.some((p) => p.type === t)).map((t) => (
              <option key={t} value={t}>
                {sentence(t)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={labelCls}>Days per year</span>
          <input className={`${inputCls} w-28`} value={f.yearlyDays} onChange={(e) => setF({ ...f, yearlyDays: e.target.value })} inputMode="numeric" />
        </label>
        <label className="block">
          <span className={labelCls}>Carry-over cap</span>
          <input className={`${inputCls} w-28`} value={f.carry} onChange={(e) => setF({ ...f, carry: e.target.value })} inputMode="numeric" />
        </label>
        <button type="button" className={btnPrimary} onClick={addPolicy} disabled={policies.rows.length >= 3}>
          <Plus size={15} /> Add policy
        </button>
      </div>
      {loading ? (
        <LoadingLine label="Loading balances…" />
      ) : types.length > 0 && members.length > 0 ? (
        <div className={tableWrapCls}>
          <table className={`${tableCls} min-w-[640px]`}>
            <thead>
              <tr>
                <th className={thCls}>Person</th>
                {types.map((t) => (
                  <th key={t} className={`${thCls} text-right`}>
                    {sentence(t)} available
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.memberId}>
                  <td className={tdCls}>{m.name}</td>
                  {types.map((t) => {
                    const b = m.balances.find((x) => x.type === t);
                    return (
                      <td key={t} className={`${tdCls} text-right tabular-nums`} title={b ? `carried ${days(b.carriedIn)} + accrued ${days(b.accrued)} − taken ${days(b.taken)} + adjustments ${days(b.adjustments)}` : undefined}>
                        {b ? `${days(b.available)} d` : "—"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {members.length > 0 && types.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className={labelCls}>Adjust balance for</span>
            <select className={selectCls} value={adj.memberId} onChange={(e) => setAdj({ ...adj, memberId: e.target.value })}>
              <option value="">Choose a person</option>
              {members.map((m) => (
                <option key={m.memberId} value={m.memberId}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={labelCls}>Type</span>
            <select className={selectCls} value={adj.type} onChange={(e) => setAdj({ ...adj, type: e.target.value })}>
              {types.map((t) => (
                <option key={t} value={t}>
                  {sentence(t)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={labelCls}>Days (+/−)</span>
            <input className={`${inputCls} w-24`} value={adj.days} onChange={(e) => setAdj({ ...adj, days: e.target.value })} inputMode="decimal" />
          </label>
          <label className="block">
            <span className={labelCls}>Reason</span>
            <input className={inputCls} value={adj.note} onChange={(e) => setAdj({ ...adj, note: e.target.value })} />
          </label>
          <button type="button" className={btnGhost} disabled={!adj.memberId || !Number(adj.days)} onClick={addAdjustment}>
            Record adjustment
          </button>
        </div>
      )}
    </div>
  );
}

const STAGES = ["applied", "screening", "interview", "offer", "hired", "rejected"].map((id) => ({ id, label: sentence(id) }));

export function RecruitingView() {
  const openings = useOpsList<OpeningRow>("job-openings");
  const departments = useOpsList<DepartmentRow>("departments");
  const [openingId, setOpeningId] = useState("");
  const applicants = useOpsList<ApplicantRow>("applicants", { openingId: openingId || undefined });
  const [local, setLocal] = useState<ApplicantRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [modal, setModal] = useState<"opening" | "applicant" | null>(null);
  useEffect(() => setLocal(null), [applicants.rows]);
  const list = local ?? applicants.rows;
  const O = new Map(openings.rows.map((o) => [o.id, o]));

  const move = async (id: string, stage: string) => {
    const before = list;
    setLocal(list.map((a) => (a.id === id ? { ...a, stage } : a)));
    setNote(null);
    try {
      await opsJson("/api/ops/applicants", "PATCH", { id, stage });
      setError(null);
      if (stage === "hired") {
        setNote("Hired — they’re now in your team directory.");
        applicants.reload();
      }
    } catch (e) {
      setLocal(before);
      setError(e instanceof Error ? e.message : "Move failed.");
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <ViewHeader title="Recruiting" hint="Drag applicants through the stages. Moving someone to Hired adds them to the team directory." />
      <div className="flex flex-wrap items-center gap-2">
        <select className={selectCls} value={openingId} onChange={(e) => setOpeningId(e.target.value)} aria-label="Job opening">
          <option value="">All openings</option>
          {openings.rows.map((o) => (
            <option key={o.id} value={o.id}>
              {o.title}
              {o.status !== "open" ? ` (${o.status})` : ""}
            </option>
          ))}
        </select>
        <button type="button" className={btnPrimary} onClick={() => setModal("opening")}>
          <Plus size={15} /> New opening
        </button>
        <button type="button" className={btnGhost} onClick={() => setModal("applicant")} disabled={!openings.rows.some((o) => o.status !== "closed")}>
          <UserPlus size={15} /> Add applicant
        </button>
      </div>
      {(error || applicants.error) && <div className={errorBoxCls}>{error ?? applicants.error}</div>}
      {note && <div className={noteBoxCls}>{note}</div>}
      {applicants.loading ? (
        <LoadingLine label="Loading applicants…" />
      ) : openings.rows.length === 0 ? (
        <EmptyBlock icon={Briefcase} title="No openings yet" hint="Create a job opening, then add applicants." />
      ) : (
        <Board
          columns={STAGES}
          items={list}
          columnOf={(a) => a.stage}
          cardLabel={(a) => a.name}
          onMove={move}
          emptyHint="Drop applicants here"
          renderHeader={(c, col) => (
            <span className="flex items-center gap-2">
              <span className={chipCls}>{c.label}</span>
              <span className="text-[0.75rem] font-semibold tabular-nums text-muted">{col.length}</span>
            </span>
          )}
          renderCard={(a) => (
            <>
              <div className="flex items-center gap-2">
                <Avatar name={a.name} size={22} />
                <span className="truncate text-[0.8125rem] font-semibold text-ink">{a.name}</span>
              </div>
              <div className="mt-1 truncate text-[0.75rem] text-muted">{O.get(a.openingId)?.title ?? ""}</div>
              {a.rating != null && <div className="mt-1 text-[0.75rem] text-muted">Rating {a.rating}/5</div>}
            </>
          )}
        />
      )}
      {modal === "opening" && <NewOpeningModal departments={departments.rows} onClose={() => setModal(null)} onCreated={openings.reload} />}
      {modal === "applicant" && (
        <NewApplicantModal openings={openings.rows.filter((o) => o.status !== "closed")} defaultOpeningId={openingId} onClose={() => setModal(null)} onCreated={applicants.reload} />
      )}
    </div>
  );
}

function NewOpeningModal({ departments, onClose, onCreated }: { departments: DepartmentRow[]; onClose: () => void; onCreated: () => void }) {
  const [f, setF] = useState({ title: "", departmentId: "", location: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await opsJson("/api/ops/job-openings", "POST", { title: f.title.trim(), ...(f.departmentId ? { departmentId: f.departmentId } : {}), ...(f.location.trim() ? { location: f.location.trim() } : {}) });
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the opening.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <OpsModal title="New job opening" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <label className="block">
          <span className={labelCls}>Title</span>
          <input className={`${inputCls} w-full`} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </label>
        <label className="block">
          <span className={labelCls}>Department</span>
          <select className={`${selectCls} w-full`} value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })}>
            <option value="">None</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={labelCls}>Location</span>
          <input className={`${inputCls} w-full`} value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} />
        </label>
        {error && <div className={errorBoxCls}>{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={busy || !f.title.trim()} onClick={submit}>
            {busy && <Loader2 size={14} className="animate-spin" />} Create opening
          </button>
        </div>
      </div>
    </OpsModal>
  );
}

function NewApplicantModal({ openings, defaultOpeningId, onClose, onCreated }: { openings: OpeningRow[]; defaultOpeningId: string; onClose: () => void; onCreated: () => void }) {
  const [f, setF] = useState({ openingId: defaultOpeningId || openings[0]?.id || "", name: "", email: "", source: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await opsJson("/api/ops/applicants", "POST", { openingId: f.openingId, name: f.name.trim(), ...(f.email.trim() ? { email: f.email.trim() } : {}), ...(f.source.trim() ? { source: f.source.trim() } : {}) });
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the applicant.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <OpsModal title="Add applicant" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <label className="block">
          <span className={labelCls}>Opening</span>
          <select className={`${selectCls} w-full`} value={f.openingId} onChange={(e) => setF({ ...f, openingId: e.target.value })}>
            {openings.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={labelCls}>Name</span>
          <input className={`${inputCls} w-full`} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={labelCls}>Email</span>
            <input className={`${inputCls} w-full`} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </label>
          <label className="block">
            <span className={labelCls}>Source</span>
            <input className={`${inputCls} w-full`} value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} placeholder="Referral, job board…" />
          </label>
        </div>
        {error && <div className={errorBoxCls}>{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={busy || !f.name.trim() || !f.openingId} onClick={submit}>
            {busy && <Loader2 size={14} className="animate-spin" />} Add applicant
          </button>
        </div>
      </div>
    </OpsModal>
  );
}
