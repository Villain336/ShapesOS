// ShapesOS Phase 10 (ops-core) — /dashboard/ops/helpdesk: tickets (dense
// table + conversation slide-over with reply / internal note), SLA policies
// and the workspace's support address. Ticket statuses and SLA clocks are
// workflow states → neutral chips (the four status colours stay reserved
// for agent states).

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { LifeBuoy, Loader2, Mail, MessageSquare, Plus, Search, Send, StickyNote, Timer } from "lucide-react";
import {
  btnGhost,
  btnPrimary,
  chipCls,
  errorBoxCls,
  infoBoxCls,
  inputCls,
  labelCls,
  noteBoxCls,
  selectCls,
  tableCls,
  tableWrapCls,
  tdCls,
  thCls,
  trClickableCls,
} from "@/components/crm/ui";
import { slaState } from "@/lib/ops/helpdesk-sla";
import { activateOnKey } from "@/lib/ui/keyboard";
import { usePeople, type Person } from "./ProjectsViews";
import { EmptyBlock, LoadingLine, OpsModal, OpsSlideOver, ViewHeader, fmtDateTime, opsJson, sentence, useOpsList } from "./shared";
import { SubTabs } from "./SubTabs";

interface TicketRow {
  id: string;
  number: number;
  subject: string;
  status: string;
  priority: string;
  channel: string;
  requesterEmail: string | null;
  requesterName: string | null;
  assigneeId: string | null;
  firstResponseDueAt: string | null;
  resolutionDueAt: string | null;
  firstRespondedAt: string | null;
  solvedAt: string | null;
  closedAt: string | null;
  slaBreachedAt: string | null;
  lastMessageAt: string;
  createdAt: string;
}
interface MessageRow {
  id: string;
  direction: "inbound" | "outbound" | "note";
  authorUserId: string | null;
  fromEmail: string | null;
  toEmail: string | null;
  body: string;
  deliveryStatus: string | null;
  error: string | null;
  createdAt: string;
}
interface SlaRow {
  id: string;
  priority: string;
  firstResponseMinutes: number;
  resolutionMinutes: number;
  active: boolean;
}

function dueLabel(t: TicketRow): string {
  const s = slaState(t, new Date());
  if (s.breach) return s.breach === "first_response" ? "First response missed" : "Resolution missed";
  if (t.status === "solved" || t.status === "closed") return "Met";
  const due = s.firstResponse === "running" ? t.firstResponseDueAt : t.resolutionDueAt;
  if (!due) return "—";
  const mins = Math.round((new Date(due).getTime() - Date.now()) / 60_000);
  const what = s.firstResponse === "running" ? "Reply" : "Resolve";
  return mins < 60 ? `${what} in ${mins}m` : mins < 48 * 60 ? `${what} in ${Math.round(mins / 60)}h` : `${what} in ${Math.round(mins / 1440)}d`;
}

const minutesText = (m: number) => (m % 1440 === 0 ? `${m / 1440}d` : m % 60 === 0 ? `${m / 60}h` : `${m}m`);

export function HelpdeskWorkspace() {
  const tabs = useMemo(
    () => [
      { id: "tickets", label: "Tickets", icon: LifeBuoy, render: () => <TicketsView /> },
      { id: "sla", label: "SLA policies", icon: Timer, render: () => <SlaPoliciesView /> },
      { id: "email", label: "Support email", icon: Mail, render: () => <SupportEmailView /> },
    ],
    [],
  );
  return <SubTabs tabs={tabs} ariaLabel="Helpdesk views" />;
}

export function TicketsView() {
  const [status, setStatus] = useState("active");
  const [priority, setPriority] = useState("");
  const [q, setQ] = useState("");
  const tickets = useOpsList<TicketRow>("tickets", { priority: priority || undefined, status: status !== "active" && status ? status : undefined });
  const { people, nameOf } = usePeople();
  const [openId, setOpenId] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("ticket");
    if (id) setOpenId(id);
  }, []);
  const rows = useMemo(() => {
    const n = q.trim().toLowerCase();
    return tickets.rows
      .filter((t) => (status === "active" ? ["new", "open", "pending"].includes(t.status) : true))
      .filter((t) => !n || `${t.number} ${t.subject} ${t.requesterEmail ?? ""} ${t.requesterName ?? ""}`.toLowerCase().includes(n));
  }, [tickets.rows, q, status]);
  const breached = rows.filter((t) => slaState(t, new Date()).breach).length;

  return (
    <div className="flex flex-col gap-4">
      <ViewHeader title="Tickets" hint="Email to your support address opens a ticket; replies thread back by the [#number] in the subject.">
        <span>
          Missed SLA <span className="font-bold tabular-nums text-ink">{breached}</span>
        </span>
      </ViewHeader>
      <div className="flex flex-wrap items-center gap-2">
        <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="active">Active (new, open, pending)</option>
          {["new", "open", "pending", "solved", "closed"].map((s) => (
            <option key={s} value={s}>
              {sentence(s)}
            </option>
          ))}
          <option value="">All</option>
        </select>
        <select className={selectCls} value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority">
          <option value="">Any priority</option>
          {["urgent", "high", "normal", "low"].map((p) => (
            <option key={p} value={p}>
              {sentence(p)}
            </option>
          ))}
        </select>
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
          <input className={`${inputCls} pl-8`} placeholder="Search tickets…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button type="button" className={btnPrimary} onClick={() => setShow(true)}>
          <Plus size={15} /> New ticket
        </button>
      </div>
      {tickets.error && <div className={errorBoxCls}>{tickets.error}</div>}
      {tickets.loading ? (
        <LoadingLine label="Loading tickets…" />
      ) : rows.length === 0 ? (
        <EmptyBlock icon={LifeBuoy} title="No tickets here" hint="New support email and tickets you open appear here." />
      ) : (
        <div className={tableWrapCls}>
          <table className={`${tableCls} min-w-[900px]`}>
            <thead>
              <tr>
                <th className={thCls}>Ticket</th>
                <th className={thCls}>Subject</th>
                <th className={thCls}>Requester</th>
                <th className={thCls}>Status</th>
                <th className={thCls}>Priority</th>
                <th className={thCls}>Assignee</th>
                <th className={thCls}>SLA</th>
                <th className={thCls}>Last message</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className={trClickableCls} tabIndex={0} onClick={() => setOpenId(t.id)} onKeyDown={activateOnKey(() => setOpenId(t.id))}>
                  <td className={`${tdCls} font-mono font-semibold`}>#{t.number}</td>
                  <td className={`${tdCls} max-w-[280px] truncate`}>{t.subject}</td>
                  <td className={`${tdCls} text-muted`}>{t.requesterName ?? t.requesterEmail ?? "—"}</td>
                  <td className={tdCls}>
                    <span className={chipCls}>{sentence(t.status)}</span>
                  </td>
                  <td className={tdCls}>{sentence(t.priority)}</td>
                  <td className={`${tdCls} text-muted`}>{nameOf(t.assigneeId)}</td>
                  <td className={tdCls}>
                    <span className={chipCls}>{dueLabel(t)}</span>
                  </td>
                  <td className={`${tdCls} text-muted`}>{fmtDateTime(t.lastMessageAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {openId && <TicketDetail ticketId={openId} people={people} onClose={() => setOpenId(null)} onChanged={tickets.reload} />}
      {show && <NewTicketModal people={people} onClose={() => setShow(false)} onCreated={tickets.reload} />}
    </div>
  );
}

function TicketDetail({ ticketId, people, onClose, onChanged }: { ticketId: string; people: Person[]; onClose: () => void; onChanged: () => void }) {
  const [ticket, setTicket] = useState<TicketRow | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [reply, setReply] = useState("");
  const [after, setAfter] = useState<"pending" | "solved" | "open">("pending");
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const nameOf = (id: string | null) => people.find((p) => p.userId === id)?.name ?? (id ? "Member" : "System");

  const load = useCallback(async () => {
    try {
      const { data } = await opsJson(`/api/ops/tickets/${encodeURIComponent(ticketId)}/messages`, "GET");
      setTicket(data.ticket as TicketRow);
      setMessages((data.messages ?? []) as MessageRow[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the ticket.");
    }
  }, [ticketId]);
  useEffect(() => {
    load();
  }, [load]);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await opsJson("/api/ops/tickets", "PATCH", { id: ticketId, ...body });
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed.");
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!reply.trim()) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      if (mode === "note") {
        await opsJson(`/api/ops/tickets/${encodeURIComponent(ticketId)}/messages`, "POST", { body: reply });
        setNote("Note added.");
      } else {
        // A failed send answers 502 with the recorded error (opsJson throws it).
        await opsJson(`/api/ops/tickets/${encodeURIComponent(ticketId)}/reply`, "POST", { body: reply, status: after });
        setNote("Reply sent.");
      }
      setReply("");
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send.");
    } finally {
      setBusy(false);
    }
  }

  if (!ticket) {
    return (
      <OpsSlideOver title="Ticket" onClose={onClose}>
        {error ? <div className={errorBoxCls}>{error}</div> : <LoadingLine label="Loading ticket…" />}
      </OpsSlideOver>
    );
  }
  const terminal = ticket.status === "closed";
  return (
    <OpsSlideOver
      title={
        <>
          <span className="font-mono">#{ticket.number}</span> <span className="truncate">{ticket.subject}</span>
        </>
      }
      meta={`${ticket.requesterName ?? ticket.requesterEmail ?? "No requester"} · ${dueLabel(ticket)}`}
      onClose={onClose}
    >
      {error && <div className={`${errorBoxCls} mb-3`}>{error}</div>}
      {note && <div className={`${noteBoxCls} mb-3`}>{note}</div>}
      <div className="mb-4 grid grid-cols-3 gap-2">
        <label className="block">
          <span className={labelCls}>Status</span>
          <select className={`${selectCls} w-full`} value={ticket.status} disabled={busy || terminal} onChange={(e) => patch({ status: e.target.value })}>
            <option value={ticket.status}>{sentence(ticket.status)}</option>
            {(["open", "pending", "solved", "closed"] as const)
              .filter((s) => s !== ticket.status)
              .map((s) => (
                <option key={s} value={s}>
                  {sentence(s)}
                </option>
              ))}
          </select>
        </label>
        <label className="block">
          <span className={labelCls}>Priority</span>
          <select className={`${selectCls} w-full`} value={ticket.priority} disabled={busy || terminal} onChange={(e) => patch({ priority: e.target.value })}>
            {["urgent", "high", "normal", "low"].map((p) => (
              <option key={p} value={p}>
                {sentence(p)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={labelCls}>Assignee</span>
          <select className={`${selectCls} w-full`} value={ticket.assigneeId ?? ""} disabled={busy || terminal} onChange={(e) => patch({ assigneeId: e.target.value || null })}>
            <option value="">Unassigned</option>
            {people.map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ol className="flex flex-col gap-2.5">
        {messages.map((m) => (
          <li key={m.id} className={`rounded-lg border px-3 py-2.5 ${m.direction === "note" ? "border-line bg-canvas" : m.direction === "outbound" ? "border-line bg-paper" : "border-line-strong bg-paper"}`}>
            <p className="mb-1 flex items-center gap-2 text-[12px] text-muted">
              {m.direction === "note" ? <StickyNote size={12} /> : m.direction === "outbound" ? <Send size={12} /> : <MessageSquare size={12} />}
              {m.direction === "inbound" ? m.fromEmail ?? "Customer" : m.direction === "outbound" ? `${nameOf(m.authorUserId)} → ${m.toEmail ?? ""}` : `Internal note · ${nameOf(m.authorUserId)}`}
              <span className="ml-auto">{fmtDateTime(m.createdAt)}</span>
              {m.deliveryStatus && m.deliveryStatus !== "sent" && <span className={chipCls}>{sentence(m.deliveryStatus)}</span>}
            </p>
            <p className="whitespace-pre-wrap text-[13px] text-ink">{m.body}</p>
            {m.error && <p className="mt-1 text-[12px] text-failed-text">{m.error}</p>}
          </li>
        ))}
        {messages.length === 0 && <li className="text-[13px] text-muted">No messages yet.</li>}
      </ol>
      {!terminal && (
        <div className="mt-4 flex flex-col gap-2">
          <div className="flex gap-2" role="tablist" aria-label="Reply or note">
            {(["reply", "note"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-pressed={mode === k}
                className={`rounded-full px-3 py-1 text-[12px] font-semibold ${mode === k ? "bg-ink text-white" : "bg-paper text-ink shadow-outline"}`}
                onClick={() => setMode(k)}
              >
                {k === "reply" ? "Reply to customer" : "Internal note"}
              </button>
            ))}
          </div>
          <textarea
            className="min-h-[110px] rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-[13px] text-ink focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder={mode === "reply" ? (ticket.requesterEmail ? `Email ${ticket.requesterEmail}…` : "This ticket has no requester email") : "Only your team sees notes"}
            aria-label={mode === "reply" ? "Reply" : "Note"}
          />
          <div className="flex items-center justify-end gap-2">
            {mode === "reply" && (
              <select className={selectCls} value={after} onChange={(e) => setAfter(e.target.value as typeof after)} aria-label="Status after reply">
                <option value="pending">Then: waiting on customer</option>
                <option value="solved">Then: solved</option>
                <option value="open">Then: keep open</option>
              </select>
            )}
            <button type="button" className={btnPrimary} disabled={busy || !reply.trim() || (mode === "reply" && !ticket.requesterEmail)} onClick={submit}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : mode === "reply" ? <Send size={14} /> : <StickyNote size={14} />}
              {mode === "reply" ? "Send reply" : "Add note"}
            </button>
          </div>
        </div>
      )}
    </OpsSlideOver>
  );
}

function NewTicketModal({ people, onClose, onCreated }: { people: Person[]; onClose: () => void; onCreated: () => void }) {
  const [f, setF] = useState({ subject: "", body: "", requesterEmail: "", requesterName: "", priority: "normal", assigneeId: "", channel: "web" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string> = { subject: f.subject.trim(), priority: f.priority, channel: f.channel };
      for (const k of ["body", "requesterEmail", "requesterName", "assigneeId"] as const) if (f[k].trim()) body[k] = f[k].trim();
      await opsJson("/api/ops/tickets", "POST", body);
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open the ticket.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <OpsModal title="New ticket" onClose={onClose} wide>
      <div className="flex flex-col gap-3">
        <label className="block">
          <span className={labelCls}>Subject</span>
          <input className={`${inputCls} w-full`} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={labelCls}>Requester email</span>
            <input className={`${inputCls} w-full`} value={f.requesterEmail} onChange={(e) => setF({ ...f, requesterEmail: e.target.value })} />
          </label>
          <label className="block">
            <span className={labelCls}>Requester name</span>
            <input className={`${inputCls} w-full`} value={f.requesterName} onChange={(e) => setF({ ...f, requesterName: e.target.value })} />
          </label>
          <label className="block">
            <span className={labelCls}>Priority</span>
            <select className={`${selectCls} w-full`} value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
              {["urgent", "high", "normal", "low"].map((p) => (
                <option key={p} value={p}>
                  {sentence(p)}
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
        </div>
        <label className="block">
          <span className={labelCls}>Description (internal note)</span>
          <textarea className={`${inputCls} h-24 w-full py-2`} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
        </label>
        {error && <div className={errorBoxCls}>{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={busy || !f.subject.trim()} onClick={submit}>
            {busy && <Loader2 size={14} className="animate-spin" />} Open ticket
          </button>
        </div>
      </div>
    </OpsModal>
  );
}

export function SlaPoliciesView() {
  const policies = useOpsList<SlaRow>("sla-policies");
  const [f, setF] = useState({ priority: "urgent", first: "60", resolution: "480" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function add() {
    setBusy(true);
    setError(null);
    try {
      await opsJson("/api/ops/sla-policies", "POST", { priority: f.priority, firstResponseMinutes: Number(f.first), resolutionMinutes: Number(f.resolution) });
      policies.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the policy.");
    } finally {
      setBusy(false);
    }
  }
  const defined = new Set(policies.rows.map((p) => p.priority));
  return (
    <div className="flex flex-col gap-4">
      <ViewHeader title="SLA policies" hint="Targets per priority, in minutes from when the ticket opens. Without a policy, defaults apply (urgent 1h / 8h, high 4h / 24h, normal 8h / 3d, low 24h / 7d)." />
      {(error || policies.error) && <div className={errorBoxCls}>{error ?? policies.error}</div>}
      {policies.loading ? (
        <LoadingLine label="Loading SLA policies…" />
      ) : (
        <div className={tableWrapCls}>
          <table className={tableCls}>
            <thead>
              <tr>
                <th className={thCls}>Priority</th>
                <th className={`${thCls} text-right`}>First response</th>
                <th className={`${thCls} text-right`}>Resolution</th>
                <th className={thCls}>Status</th>
              </tr>
            </thead>
            <tbody>
              {policies.rows.map((p) => (
                <tr key={p.id}>
                  <td className={tdCls}>{sentence(p.priority)}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{minutesText(p.firstResponseMinutes)}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{minutesText(p.resolutionMinutes)}</td>
                  <td className={tdCls}>
                    <span className={chipCls}>{p.active ? "Active" : "Paused"}</span>
                  </td>
                </tr>
              ))}
              {policies.rows.length === 0 && (
                <tr>
                  <td className={`${tdCls} text-muted`} colSpan={4}>
                    No custom policies — defaults apply.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className={labelCls}>Priority</span>
          <select className={selectCls} value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
            {["urgent", "high", "normal", "low"].filter((p) => !defined.has(p)).map((p) => (
              <option key={p} value={p}>
                {sentence(p)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={labelCls}>First response (min)</span>
          <input className={`${inputCls} w-32`} value={f.first} onChange={(e) => setF({ ...f, first: e.target.value })} inputMode="numeric" />
        </label>
        <label className="block">
          <span className={labelCls}>Resolution (min)</span>
          <input className={`${inputCls} w-32`} value={f.resolution} onChange={(e) => setF({ ...f, resolution: e.target.value })} inputMode="numeric" />
        </label>
        <button type="button" className={btnPrimary} disabled={busy || defined.size >= 4} onClick={add}>
          <Plus size={15} /> Add policy
        </button>
      </div>
    </div>
  );
}

export function SupportEmailView() {
  const [s, setS] = useState<{ inboundConfigured: boolean; supportAddress: string | null } | null>(null);
  useEffect(() => {
    opsJson("/api/ops/helpdesk/settings", "GET")
      .then(({ data }) => setS(data as { inboundConfigured: boolean; supportAddress: string | null }))
      .catch(() => setS({ inboundConfigured: false, supportAddress: null }));
  }, []);
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <ViewHeader title="Support email" hint="Forward your public support address (for example support@yourcompany.com) to the address below. Every email opens a ticket or threads onto one." />
      {!s ? (
        <LoadingLine label="Loading…" />
      ) : s.supportAddress ? (
        <div className={noteBoxCls}>
          <p className="text-[12px] font-semibold text-muted">Your support inbox</p>
          <p className="mt-1 select-all font-mono text-[13px] text-ink">{s.supportAddress}</p>
        </div>
      ) : (
        <div className={infoBoxCls}>
          Inbound email isn’t set up on this server yet. An administrator sets MESSAGING_INBOUND_EMAIL_DOMAIN, MESSAGING_INBOUND_EMAIL_SECRET, RESEND_INBOUND_WEBHOOK_SECRET and RESEND_API_KEY (see .env.example); until then, open tickets by hand.
        </div>
      )}
      <div className={infoBoxCls}>
        Replies you send from a ticket go out from your messaging sender with this address as Reply-To and the ticket number in the subject, so the customer’s answer lands back on the same ticket. Mail from unknown senders to your normal reply address also becomes a ticket.
      </div>
    </div>
  );
}
