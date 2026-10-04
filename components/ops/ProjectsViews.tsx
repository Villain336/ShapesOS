// ShapesOS Phase 10 (ops-core) — /dashboard/ops/projects: Projects (the
// existing ProjectsTab), a task board (shared Board) and timesheets with
// approval and "invoice unbilled time".

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Clock, Eye, EyeOff, FolderKanban, KanbanSquare, Loader2, Plus, ReceiptText, XCircle } from "lucide-react";
import { ProjectsTab } from "@/components/crm/ProjectsTab";
import {
  Avatar,
  btnGhost,
  btnGhostSm,
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
import { EmptyBlock, LoadingLine, OpsModal, ViewHeader, fmtCents, fmtDate, opsJson, sentence, shortId, toCents, useOpsList } from "./shared";
import { SubTabs } from "./SubTabs";

interface ProjectRow {
  id: string;
  name: string;
  status: string;
  hourlyRateCents: number | null;
}
interface TaskRow {
  id: string;
  projectId: string;
  title: string;
  stage: string;
  priority: string;
  assigneeId: string | null;
  dueAt: string | null;
  // Phase 10 (portal): shown to linked clients in the client portal.
  clientVisible?: boolean;
}
interface EntryRow {
  id: string;
  projectId: string;
  taskId: string | null;
  userId: string | null;
  minutes: number;
  rateCents: number | null;
  description: string | null;
  occurredAt: string;
  billable: boolean;
  billed: boolean;
  invoiceId: string | null;
  approvalStatus: "pending" | "approved" | "rejected";
}
export interface Person {
  userId: string;
  name: string;
  email: string | null;
}

export function usePeople() {
  const [people, setPeople] = useState<Person[]>([]);
  const [me, setMe] = useState<string | null>(null);
  useEffect(() => {
    opsJson("/api/ops/people", "GET")
      .then(({ data }) => {
        setPeople((data.people ?? []) as Person[]);
        setMe((data.me as string) ?? null);
      })
      .catch(() => setPeople([]));
  }, []);
  return { people, me, nameOf: (id: string | null) => people.find((p) => p.userId === id)?.name ?? (id ? "Member" : "Unassigned") };
}

const STAGES = [
  { id: "backlog", label: "Backlog" },
  { id: "todo", label: "To do" },
  { id: "in_progress", label: "In progress" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

function hours(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
}

export function ProjectsWorkspace() {
  const tabs = useMemo(
    () => [
      { id: "projects", label: "Projects", icon: FolderKanban, render: () => <ProjectsTab /> },
      { id: "tasks", label: "Tasks", icon: KanbanSquare, render: () => <TasksView /> },
      { id: "timesheets", label: "Timesheets", icon: Clock, render: () => <TimesheetsView /> },
    ],
    [],
  );
  return <SubTabs tabs={tabs} ariaLabel="Project views" />;
}

// ---------------------------------------------------------------------------
// Tasks board
// ---------------------------------------------------------------------------

export function TasksView() {
  const projects = useOpsList<ProjectRow>("projects");
  const [projectId, setProjectId] = useState("");
  const [assignee, setAssignee] = useState("");
  const tasks = useOpsList<TaskRow>("tasks", { projectId: projectId || undefined, assigneeId: assignee || undefined });
  const { people, nameOf } = usePeople();
  const [local, setLocal] = useState<TaskRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  useEffect(() => setLocal(null), [tasks.rows]);
  const list = (local ?? tasks.rows).filter((t) => t.stage !== "cancelled");
  const P = new Map(projects.rows.map((p) => [p.id, p]));

  // Phase 10 (portal): show / hide a task in the client portal.
  const toggleClient = async (id: string, clientVisible: boolean) => {
    const before = local ?? tasks.rows;
    setLocal(before.map((t) => (t.id === id ? { ...t, clientVisible } : t)));
    try {
      await opsJson("/api/ops/tasks", "PATCH", { id, clientVisible });
      setError(null);
    } catch (e) {
      setLocal(before);
      setError(e instanceof Error ? e.message : "Couldn't change client visibility.");
    }
  };

  const move = async (id: string, stage: string) => {
    const before = local ?? tasks.rows;
    setLocal(before.map((t) => (t.id === id ? { ...t, stage } : t)));
    try {
      await opsJson("/api/ops/tasks", "PATCH", { id, stage });
      setError(null);
    } catch (e) {
      setLocal(before);
      setError(e instanceof Error ? e.message : "Move failed.");
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <ViewHeader title="Tasks" hint="Drag a card to change its stage. Assignees are workspace members." />
      <div className="flex flex-wrap items-center gap-2">
        <select className={selectCls} value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
          <option value="">All projects</option>
          {projects.rows.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select className={selectCls} value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Assignee">
          <option value="">Everyone</option>
          {people.map((p) => (
            <option key={p.userId} value={p.userId}>
              {p.name}
            </option>
          ))}
        </select>
        <button type="button" className={btnPrimary} onClick={() => setShow(true)} disabled={projects.rows.length === 0}>
          <Plus size={15} /> New task
        </button>
      </div>
      {(error || tasks.error) && <div className={errorBoxCls}>{error ?? tasks.error}</div>}
      {tasks.loading ? (
        <LoadingLine label="Loading tasks…" />
      ) : projects.rows.length === 0 ? (
        <EmptyBlock icon={KanbanSquare} title="No projects yet" hint="Create a project first, then break it into tasks." />
      ) : (
        <Board
          columns={STAGES}
          items={list}
          columnOf={(t) => t.stage}
          cardLabel={(t) => t.title}
          onMove={move}
          emptyHint="Drop tasks here"
          renderHeader={(c, col) => (
            <span className="flex items-center gap-2">
              <span className={chipCls}>{c.label}</span>
              <span className="text-[12px] font-semibold tabular-nums text-muted">{col.length}</span>
            </span>
          )}
          renderCard={(t) => (
            <>
              <div className="text-[13px] font-semibold text-ink">{t.title}</div>
              <div className="mt-0.5 truncate text-[12px] text-muted">{P.get(t.projectId)?.name ?? shortId(t.projectId)}</div>
              <div className="mt-2 flex items-center justify-between gap-2 text-[12px]">
                <span className="flex items-center gap-1.5 text-muted">
                  {t.assigneeId ? <Avatar name={nameOf(t.assigneeId)} size={18} /> : null}
                  {t.dueAt ? `Due ${fmtDate(t.dueAt)}` : "No due date"}
                </span>
                {t.priority !== "normal" && <span className={chipCls}>{sentence(t.priority)}</span>}
              </div>
              <button
                type="button"
                className={`${btnGhostSm} mt-2`}
                aria-pressed={!!t.clientVisible}
                title={t.clientVisible ? "Shown in the client portal. Hide it." : "Hidden from clients. Show it in the client portal."}
                onClick={() => toggleClient(t.id, !t.clientVisible)}
              >
                {t.clientVisible ? <Eye size={13} aria-hidden /> : <EyeOff size={13} aria-hidden />}
                {t.clientVisible ? "Client can see" : "Internal"}
              </button>
            </>
          )}
        />
      )}
      {show && <NewTaskModal projects={projects.rows} people={people} defaultProjectId={projectId} onClose={() => setShow(false)} onCreated={tasks.reload} />}
    </div>
  );
}

function NewTaskModal({
  projects,
  people,
  defaultProjectId,
  onClose,
  onCreated,
}: {
  projects: ProjectRow[];
  people: Person[];
  defaultProjectId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const open = projects.filter((p) => p.status !== "completed" && p.status !== "cancelled");
  const [f, setF] = useState({ projectId: defaultProjectId || open[0]?.id || "", title: "", assigneeId: "", priority: "normal", dueAt: "", stage: "todo", clientVisible: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await opsJson("/api/ops/tasks", "POST", {
        projectId: f.projectId,
        title: f.title.trim(),
        stage: f.stage,
        priority: f.priority,
        ...(f.assigneeId ? { assigneeId: f.assigneeId } : {}),
        ...(f.dueAt ? { dueAt: new Date(f.dueAt).toISOString() } : {}),
        ...(f.clientVisible ? { clientVisible: true } : {}),
      });
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the task.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <OpsModal title="New task" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <label className="block">
          <span className={labelCls}>Title</span>
          <input className={`${inputCls} w-full`} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={labelCls}>Project</span>
            <select className={`${selectCls} w-full`} value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })}>
              {open.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={labelCls}>Assignee</span>
            <select className={`${selectCls} w-full`} value={f.assigneeId} onChange={(e) => setF({ ...f, assigneeId: e.target.value })}>
              <option value="">Unassigned</option>
              {people.map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={labelCls}>Stage</span>
            <select className={`${selectCls} w-full`} value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value })}>
              {STAGES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={labelCls}>Priority</span>
            <select className={`${selectCls} w-full`} value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
              {["low", "normal", "high", "urgent"].map((p) => (
                <option key={p} value={p}>
                  {sentence(p)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={labelCls}>Due</span>
            <input type="date" className={`${inputCls} w-full`} value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} />
          </label>
        </div>
        {/* Phase 10 (portal) */}
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input type="checkbox" checked={f.clientVisible} onChange={(e) => setF({ ...f, clientVisible: e.target.checked })} />
          Show this task to the client in the client portal
        </label>
        {error && <div className={errorBoxCls}>{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={busy || !f.title.trim() || !f.projectId} onClick={submit}>
            {busy && <Loader2 size={14} className="animate-spin" />} Create task
          </button>
        </div>
      </div>
    </OpsModal>
  );
}

// ---------------------------------------------------------------------------
// Timesheets
// ---------------------------------------------------------------------------

export function TimesheetsView() {
  const projects = useOpsList<ProjectRow>("projects");
  const { people, nameOf } = usePeople();
  const [status, setStatus] = useState("pending");
  const [userId, setUserId] = useState("");
  const [entries, setEntries] = useState<EntryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [billProject, setBillProject] = useState("");
  const [rate, setRate] = useState("");
  const P = new Map(projects.rows.map((p) => [p.id, p]));
  useEffect(() => {
    const r = P.get(billProject)?.hourlyRateCents;
    setRate(r != null ? (r / 100).toFixed(2) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billProject, projects.rows]);

  async function saveRate() {
    const cents = rate.trim() ? toCents(rate) : null;
    if (rate.trim() && cents === null) return setError("Rate must be a dollar amount per hour.");
    setBusy(true);
    setError(null);
    try {
      await opsJson("/api/ops/projects", "PATCH", { id: billProject, hourlyRateCents: cents });
      setNote("Project rate saved.");
      projects.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the rate.");
    } finally {
      setBusy(false);
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams();
      if (status) q.set("status", status);
      if (userId) q.set("userId", userId);
      const { data } = await opsJson(`/api/ops/timesheets?${q.toString()}`, "GET");
      setEntries((data.entries ?? []) as EntryRow[]);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load timesheets.");
    } finally {
      setLoading(false);
    }
  }, [status, userId]);
  useEffect(() => {
    load();
  }, [load]);

  async function decide(decision: "approved" | "rejected") {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const { data } = await opsJson("/api/ops/timesheets", "POST", { entryIds: [...selected], decision });
      setNote(`${Number(data.updated)} entr${Number(data.updated) === 1 ? "y" : "ies"} ${decision}.`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Decision failed.");
    } finally {
      setBusy(false);
    }
  }

  async function invoiceTime() {
    if (!billProject) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const { data } = await opsJson(`/api/ops/projects/${encodeURIComponent(billProject)}/invoice-time`, "POST", {});
      const inv = data.invoice as { id: string; totalCents: number };
      setNote(`Draft invoice ${shortId(inv.id)} created for ${fmtCents(inv.totalCents)} (${Number(data.billedEntries)} entries billed). Review and send it under Invoices.`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not invoice the time.");
    } finally {
      setBusy(false);
    }
  }

  const totalMin = entries.reduce((s, e) => s + e.minutes, 0);
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  return (
    <div className="flex flex-col gap-4">
      <ViewHeader title="Timesheets" hint="Approve logged time before it can be billed. Invoicing approved time adds it to a draft invoice and marks it billed — sending still needs your approval.">
        <span>
          In view <span className="font-bold tabular-nums text-ink">{hours(totalMin)}</span>
        </span>
      </ViewHeader>
      <div className="flex flex-wrap items-center gap-2">
        <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Approval status">
          <option value="pending">Waiting for approval</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="">All</option>
        </select>
        <select className={selectCls} value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="Person">
          <option value="">Everyone</option>
          {people.map((p) => (
            <option key={p.userId} value={p.userId}>
              {p.name}
            </option>
          ))}
        </select>
        <button type="button" className={btnPrimary} onClick={() => setShowLog(true)} disabled={projects.rows.length === 0}>
          <Plus size={15} /> Log time
        </button>
        <span className="mx-1 h-6 w-px bg-line" aria-hidden />
        <select className={selectCls} value={billProject} onChange={(e) => setBillProject(e.target.value)} aria-label="Project to invoice">
          <option value="">Invoice approved time for…</option>
          {projects.rows.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {billProject && (
          <>
            <input className={`${inputCls} w-24`} value={rate} onChange={(e) => setRate(e.target.value)} placeholder="$/h" aria-label="Project hourly rate" inputMode="decimal" />
            <button type="button" className={btnGhostSm} onClick={saveRate} disabled={busy}>
              Save rate
            </button>
          </>
        )}
        <button type="button" className={btnGhost} onClick={invoiceTime} disabled={busy || !billProject}>
          <ReceiptText size={14} /> Invoice unbilled time
        </button>
      </div>
      {selected.size > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-muted">{selected.size} selected</span>
          <button type="button" className={btnGhostSm} disabled={busy} onClick={() => decide("approved")}>
            <CheckCircle2 size={13} /> Approve
          </button>
          <button type="button" className={btnGhostSm} disabled={busy} onClick={() => decide("rejected")}>
            <XCircle size={13} /> Reject
          </button>
        </div>
      )}
      {error && <div className={errorBoxCls}>{error}</div>}
      {note && <div className={noteBoxCls}>{note}</div>}
      {loading ? (
        <LoadingLine label="Loading timesheets…" />
      ) : entries.length === 0 ? (
        <EmptyBlock icon={Clock} title="Nothing here" hint={status === "pending" ? "No time is waiting for approval." : "No time entries match."} />
      ) : (
        <div className={tableWrapCls}>
          <table className={`${tableCls} min-w-[860px]`}>
            <thead>
              <tr>
                <th className={thCls} aria-label="Select" />
                <th className={thCls}>Date</th>
                <th className={thCls}>Person</th>
                <th className={thCls}>Project</th>
                <th className={thCls}>Description</th>
                <th className={`${thCls} text-right`}>Time</th>
                <th className={`${thCls} text-right`}>Rate</th>
                <th className={thCls}>Status</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className={tdCls}>
                    {e.approvalStatus === "pending" && !e.billed && (
                      <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} aria-label="Select entry" />
                    )}
                  </td>
                  <td className={`${tdCls} text-muted`}>{fmtDate(e.occurredAt)}</td>
                  <td className={tdCls}>{nameOf(e.userId)}</td>
                  <td className={tdCls}>{P.get(e.projectId)?.name ?? shortId(e.projectId)}</td>
                  <td className={`${tdCls} text-muted`}>{e.description ?? "—"}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{hours(e.minutes)}</td>
                  <td className={`${tdCls} text-right tabular-nums text-muted`}>
                    {e.rateCents != null ? `${fmtCents(e.rateCents)}/h` : P.get(e.projectId)?.hourlyRateCents != null ? `${fmtCents(P.get(e.projectId)!.hourlyRateCents!)}/h` : "—"}
                  </td>
                  <td className={tdCls}>
                    <span className={chipCls}>{e.billed ? "Billed" : !e.billable ? "Non-billable" : sentence(e.approvalStatus)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showLog && <LogTimeModal projects={projects.rows} people={people} onClose={() => setShowLog(false)} onLogged={load} />}
    </div>
  );
}

function LogTimeModal({ projects, people, onClose, onLogged }: { projects: ProjectRow[]; people: Person[]; onClose: () => void; onLogged: () => void }) {
  const [f, setF] = useState({ projectId: projects[0]?.id ?? "", hours: "1", minutes: "0", description: "", userId: "", rate: "", billable: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    const minutes = Number(f.hours || 0) * 60 + Number(f.minutes || 0);
    if (!Number.isInteger(minutes) || minutes <= 0) return setError("Enter whole hours and minutes.");
    const rateCents = f.rate.trim() ? toCents(f.rate) : undefined;
    if (rateCents === null) return setError("Rate must be a dollar amount per hour.");
    setBusy(true);
    setError(null);
    try {
      await opsJson(`/api/ops/projects/${encodeURIComponent(f.projectId)}/time-entries`, "POST", {
        minutes,
        ...(f.description.trim() ? { description: f.description.trim() } : {}),
        ...(f.userId ? { userId: f.userId } : {}),
        ...(rateCents !== undefined ? { rateCents } : {}),
        billable: f.billable,
      });
      onLogged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not log the time.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <OpsModal title="Log time" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <label className="block">
          <span className={labelCls}>Project</span>
          <select className={`${selectCls} w-full`} value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={labelCls}>Hours</span>
            <input className={`${inputCls} w-full`} value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} inputMode="numeric" />
          </label>
          <label className="block">
            <span className={labelCls}>Minutes</span>
            <input className={`${inputCls} w-full`} value={f.minutes} onChange={(e) => setF({ ...f, minutes: e.target.value })} inputMode="numeric" />
          </label>
          <label className="block">
            <span className={labelCls}>Person</span>
            <select className={`${selectCls} w-full`} value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}>
              <option value="">Me</option>
              {people.map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={labelCls}>Rate ($/h, blank = project rate)</span>
            <input className={`${inputCls} w-full`} value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} inputMode="decimal" />
          </label>
        </div>
        <label className="block">
          <span className={labelCls}>Description</span>
          <input className={`${inputCls} w-full`} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </label>
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input type="checkbox" checked={f.billable} onChange={(e) => setF({ ...f, billable: e.target.checked })} /> Billable
        </label>
        {error && <div className={errorBoxCls}>{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={busy || !f.projectId} onClick={submit}>
            {busy && <Loader2 size={14} className="animate-spin" />} Log time
          </button>
        </div>
      </div>
    </OpsModal>
  );
}
