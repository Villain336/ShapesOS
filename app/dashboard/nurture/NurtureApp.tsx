// Marketr — nurture workspace app: sequences, enrollments, approval queue,
// message log, consent matrix. Agentic OS design system.
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  Check,
  ChevronRight,
  ClipboardCheck,
  History,
  Pause,
  Play,
  Plus,
  Pencil,
  Search,
  Send,
  ShieldCheck,
  Users,
  X,
  Zap,
  MessageSquarePlus,
} from "lucide-react";
import type {
  ApprovalRow,
  ConsentRow,
  Enrollment,
  LeadOption,
  NurtureSequence,
  OutboundMessageRow,
} from "./types";
import { SequenceBuilder } from "./SequenceBuilder";
import { BroadcastsTab } from "./BroadcastsTab";
import {
  ChannelChip,
  Chip,
  DoneBadge,
  EmptyState,
  Modal,
  NeedsBadge,
  btnApprove,
  btnDanger,
  btnPrimary,
  btnSecondary,
  inputCls,
} from "./ui";
import { confirmAction } from "@/lib/ui/feedback";
import type { NurtureTab } from "./tabs";

type Tab = NurtureTab;

async function api<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...opts, headers: { "content-type": "application/json", ...(opts?.headers ?? {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1d ago" : `${d}d ago`;
}

function delayLabel(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function NurtureApp({ initialTab = "sequences" }: { initialTab?: Tab } = {}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [sequences, setSequences] = useState<NurtureSequence[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [builderOpen, setBuilderOpen] = useState<null | { initial?: NurtureSequence | null }>(null);
  const [builderSaving, setBuilderSaving] = useState(false);
  const [builderError, setBuilderError] = useState<string | null>(null);
  const [engineRunning, setEngineRunning] = useState(false);
  const [engineResult, setEngineResult] = useState<string | null>(null);

  const refreshSequences = useCallback(async () => {
    const data = await api<{ sequences: NurtureSequence[] }>("/api/nurture/sequences");
    setSequences(data.sequences);
    if (!selectedId && data.sequences.length) setSelectedId(data.sequences[0].id);
    return data.sequences;
  }, [selectedId]);

  useEffect(() => {
    refreshSequences().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = useMemo(
    () => sequences.find((s) => s.id === selectedId) ?? null,
    [sequences, selectedId],
  );

  const pendingApprovals = usePendingApprovals(tab === "approvals");

  const runEngine = async () => {
    setEngineRunning(true);
    setEngineResult(null);
    try {
      const r = await api<{ advanced: number; completed: number; skipped: number; errors: unknown[] }>(
        "/api/cron/nurture",
        { method: "POST" },
      );
      setEngineResult(`Engine tick: ${r.advanced} advanced, ${r.completed} completed, ${r.skipped} skipped, ${r.errors.length} errors.`);
      await refreshSequences();
    } catch (e) {
      setEngineResult(e instanceof Error ? e.message : "Engine tick failed");
    } finally {
      setEngineRunning(false);
    }
  };

  const saveBuilder = async (data: {
    name: string;
    description?: string;
    steps: NurtureSequence["steps"];
    status: string;
    dailyCap: number | null;
  }) => {
    setBuilderSaving(true);
    setBuilderError(null);
    try {
      const initial = builderOpen?.initial;
      if (initial?.id) {
        await api(`/api/nurture/sequences/${initial.id}`, { method: "PATCH", body: JSON.stringify(data) });
      } else {
        await api("/api/nurture/sequences", { method: "POST", body: JSON.stringify(data) });
      }
      const list = await refreshSequences();
      const match = list.find((s) => s.name === data.name) ?? null;
      if (match) setSelectedId(match.id);
      setBuilderOpen(null);
    } catch (e) {
      setBuilderError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBuilderSaving(false);
    }
  };

  const setSequenceStatus = async (id: string, status: string) => {
    await api(`/api/nurture/sequences/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
    await refreshSequences();
  };

  const archiveSequence = async (id: string) => {
    if (!await confirmAction("Archive this sequence? Enrollments stop advancing; the message ledger is kept.")) return;
    await api(`/api/nurture/sequences/${id}`, { method: "DELETE" });
    await refreshSequences();
  };

  const tabs: Array<{ id: Tab; label: string; Icon: typeof Users; badge?: number }> = [
    { id: "sequences", label: "Sequences", Icon: MessageSquarePlus },
    { id: "broadcasts", label: "Broadcasts", Icon: Send },
    { id: "enrollments", label: "Enrollments", Icon: Users },
    { id: "approvals", label: "Approvals", Icon: ClipboardCheck, badge: pendingApprovals },
    { id: "log", label: "Message log", Icon: History },
    { id: "consent", label: "Consent", Icon: ShieldCheck },
  ];

  if (loading) return <div className="p-8 text-sm text-muted">Loading nurture workspace…</div>;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line">
        <div className="flex gap-1">
          {tabs.map(({ id, label, Icon, badge }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] font-medium transition-colors ${
                tab === id ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"
              }`}
            >
              <Icon size={15} />
              {label}
              {badge ? (
                <span className="rounded-full bg-needs px-1.5 text-[11px] font-semibold text-ink">
                  {badge}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {engineResult ? <span className="text-xs text-muted">{engineResult}</span> : null}
          <button className={btnSecondary} onClick={runEngine} disabled={engineRunning} title="Advance due enrollments now (session-scoped)">
            <Zap size={14} /> {engineRunning ? "Running…" : "Run engine now"}
          </button>
        </div>
      </div>

      {tab === "sequences" ? (
        <SequencesTab
          sequences={sequences}
          selected={selected}
          onSelect={setSelectedId}
          onCreate={() => { setBuilderError(null); setBuilderOpen({ initial: null }); }}
          onEdit={(s) => { setBuilderError(null); setBuilderOpen({ initial: s }); }}
          onStatus={setSequenceStatus}
          onArchive={archiveSequence}
          onEnrolled={() => refreshSequences()}
        />
      ) : null}
      {tab === "broadcasts" ? <BroadcastsTab /> : null}
      {tab === "enrollments" ? <EnrollmentsTab /> : null}
      {tab === "approvals" ? <ApprovalsTab /> : null}
      {tab === "log" ? <MessageLogTab /> : null}
      {tab === "consent" ? <ConsentTab /> : null}

      {builderOpen ? (
        <Modal title={builderOpen.initial ? "Edit sequence" : "New sequence"} onClose={() => setBuilderOpen(null)} wide>
          <SequenceBuilder
            initial={builderOpen.initial ?? null}
            saving={builderSaving}
            error={builderError}
            onSave={saveBuilder}
            onCancel={() => setBuilderOpen(null)}
          />
        </Modal>
      ) : null}
    </div>
  );
}

function usePendingApprovals(active: boolean): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await api<{ total: number }>("/api/nurture/approvals?status=pending&limit=1");
        if (!cancelled) setCount(data.total);
      } catch { /* badge is best-effort */ }
    };
    load();
    const t = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(t); };
  }, [active]);
  return count;
}

/* ── Sequences tab ─────────────────────────────────────────────── */

function SequencesTab({
  sequences,
  selected,
  onSelect,
  onCreate,
  onEdit,
  onStatus,
  onArchive,
  onEnrolled,
}: {
  sequences: NurtureSequence[];
  selected: NurtureSequence | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onEdit: (s: NurtureSequence) => void;
  onStatus: (id: string, status: string) => Promise<void>;
  onArchive: (id: string) => Promise<void>;
  onEnrolled: () => void;
}) {
  const [enrollOpen, setEnrollOpen] = useState(false);
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[300px_1fr]">
      <div className="rounded-lg bg-paper shadow-hairline">
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <span className="text-[13px] font-semibold text-ink">Sequences ({sequences.length})</span>
          <button className={btnPrimary} onClick={onCreate}>
            <Plus size={14} /> New
          </button>
        </div>
        <div className="max-h-[70vh] divide-y divide-line overflow-y-auto">
          {sequences.length === 0 ? (
            <div className="p-4"><EmptyState title="No sequences yet" hint="Create your first nurture sequence." /></div>
          ) : sequences.map((s) => (
            <button
              key={s.id}
              onClick={() => onSelect(s.id)}
              className={`flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-hover-paper ${selected?.id === s.id ? "bg-canvas" : ""}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] font-semibold text-ink">{s.name}</span>
                  <Chip>{s.status}</Chip>
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted">
                  <span>{s.steps.length} steps</span>
                  <span>·</span>
                  <span>{s.stats?.enrolledActive ?? 0} enrolled</span>
                  <span>·</span>
                  <span>{s.stats?.sent ?? 0} sent</span>
                </div>
              </div>
              <ChevronRight size={14} className="shrink-0 text-subtle" />
            </button>
          ))}
        </div>
      </div>

      <div className="min-w-0">
        {selected ? (
          <SequenceDetail
            sequence={selected}
            onEdit={() => onEdit(selected)}
            onStatus={(st) => onStatus(selected.id, st)}
            onArchive={() => onArchive(selected.id)}
            onEnroll={() => setEnrollOpen(true)}
          />
        ) : (
          <EmptyState title="Select a sequence" hint="Pick one from the list to see steps and enrollments." />
        )}
      </div>

      {enrollOpen && selected ? (
        <EnrollModal sequence={selected} onClose={() => setEnrollOpen(false)} onDone={() => { setEnrollOpen(false); onEnrolled(); }} />
      ) : null}
    </div>
  );
}

function SequenceDetail({
  sequence,
  onEdit,
  onStatus,
  onArchive,
  onEnroll,
}: {
  sequence: NurtureSequence;
  onEdit: () => void;
  onStatus: (s: string) => Promise<void>;
  onArchive: () => Promise<void>;
  onEnroll: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-paper p-4 shadow-hairline">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-[16px] font-bold text-ink">{sequence.name}</h2>
              <Chip>{sequence.status}</Chip>
              {sequence.dailyCap ? <Chip title="Max sequence sends per day">cap {sequence.dailyCap}/day</Chip> : null}
            </div>
            {sequence.description ? <p className="mt-1 text-[13px] text-muted">{sequence.description}</p> : null}
            <div className="mt-2 flex gap-3 text-[12px] text-muted">
              <span><strong className="text-ink">{sequence.stats?.enrolledActive ?? 0}</strong> enrolled</span>
              <span><strong className="text-ink">{sequence.stats?.sent ?? 0}</strong> sent</span>
              <span><strong className="text-ink">{sequence.stats?.suppressed ?? 0}</strong> suppressed</span>
              <span>updated {timeAgo(sequence.updatedAt)}</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button className={btnPrimary} onClick={onEnroll}><Plus size={14} /> Enroll leads</button>
            <button className={btnSecondary} onClick={onEdit}><Pencil size={14} /> Edit</button>
            {sequence.status === "draft" || sequence.status === "paused" ? (
              <button className={btnSecondary} onClick={() => onStatus("active")}><Play size={14} /> Activate</button>
            ) : null}
            {sequence.status === "active" ? (
              <button className={btnSecondary} onClick={() => onStatus("paused")}><Pause size={14} /> Pause</button>
            ) : null}
            {sequence.status !== "archived" ? (
              <button className={btnDanger} onClick={onArchive}><Archive size={14} /> Archive</button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="rounded-lg bg-paper shadow-hairline">
        <div className="border-b border-line px-4 py-2">
          <span className="text-[13px] font-semibold text-ink">Steps</span>
        </div>
        <div className="divide-y divide-line">
          {sequence.steps.length === 0 ? (
            <div className="p-4 text-[13px] text-subtle">No steps yet — edit the sequence to add some.</div>
          ) : sequence.steps.map((step, i) => (
            <div key={i} className="flex gap-3 px-4 py-2.5">
              <div className="flex w-16 shrink-0 flex-col items-center gap-1">
                <span className="text-xs font-semibold text-muted">Step {i + 1}</span>
                {i > 0 ? <Chip>+{delayLabel(step.delayMinutes)}</Chip> : <Chip>now</Chip>}
              </div>
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center gap-2">
                  <ChannelChip channel={step.channel} />
                  {step.subject ? <span className="truncate text-[12px] font-medium text-muted">“{step.subject}”</span> : null}
                </div>
                <p className="aos-mono whitespace-pre-wrap break-words text-[12px] leading-5 text-muted">{step.template}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── Enroll modal ──────────────────────────────────────────────── */

function EnrollModal({ sequence, onClose, onDone }: { sequence: NurtureSequence; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState("");
  const [leads, setLeads] = useState<LeadOption[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [searching, setSearching] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const search = async (query: string) => {
    setSearching(true);
    try {
      const data = await api<{ leads: LeadOption[] }>(`/api/crm/leads?q=${encodeURIComponent(query)}&limit=25`);
      setLeads(data.leads);
    } finally {
      setSearching(false);
    }
  };

  useEffect(() => { search(""); }, []);

  const toggle = (id: string) =>
    setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const enroll = async () => {
    setEnrolling(true);
    setResult(null);
    try {
      const data = await api<{ enrolled: number }>(
        `/api/nurture/sequences/${sequence.id}/enroll`,
        { method: "POST", body: JSON.stringify({ leadIds: [...picked] }) },
      );
      setResult(`${data.enrolled} of ${picked.size} leads enrolled.`);
      onDone();
    } catch (e) {
      setResult(e instanceof Error ? e.message : "Enroll failed");
    } finally {
      setEnrolling(false);
    }
  };

  return (
    <Modal title={`Enroll leads — ${sequence.name}`} onClose={onClose}>
      <div className="mb-2 flex gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
          <input
            className={`${inputCls} pl-8`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") search(q); }}
            placeholder="Search leads by name, email, company…"
          />
        </div>
        <button className={btnSecondary} onClick={() => search(q)} disabled={searching}>Search</button>
      </div>
      <div className="max-h-64 divide-y divide-line overflow-y-auto rounded-md border border-line">
        {leads.length === 0 ? (
          <div className="p-4 text-[13px] text-subtle">{searching ? "Searching…" : "No leads found."}</div>
        ) : leads.map((l) => (
          <label key={l.id} className="flex cursor-pointer items-center gap-2.5 px-3 py-2 hover:bg-hover-paper">
            <input type="checkbox" checked={picked.has(l.id)} onChange={() => toggle(l.id)} className="accent-ink" />
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium text-ink">{l.name}</div>
              <div className="truncate text-[12px] text-muted">{[l.company, l.email].filter(Boolean).join(" · ") || "—"}</div>
            </div>
          </label>
        ))}
      </div>
      {result ? <p className="mt-2 text-[13px] text-muted">{result}</p> : null}
      <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
        <span className="text-[12px] text-muted">{picked.size} selected</span>
        <div className="flex gap-2">
          <button className={btnSecondary} onClick={onClose}>Close</button>
          <button className={btnPrimary} disabled={picked.size === 0 || enrolling} onClick={enroll}>
            {enrolling ? "Enrolling…" : `Enroll ${picked.size} lead${picked.size === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ── Enrollments tab ───────────────────────────────────────────── */

function EnrollmentsTab() {
  const [rows, setRows] = useState<Enrollment[]>([]);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const sp = new URLSearchParams({ limit: "100" });
      if (status) sp.set("status", status);
      if (q.trim()) sp.set("q", q.trim());
      const data = await api<{ enrollments: Enrollment[] }>(`/api/nurture/enrollments?${sp}`);
      setRows(data.enrollments);
    } finally {
      setLoading(false);
    }
  }, [status, q]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="rounded-lg bg-paper shadow-hairline">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <select className={`${inputCls} w-40`} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {["active", "paused", "completed", "unenrolled", "bounced"].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
          <input className={`${inputCls} pl-8`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search lead…" />
        </div>
        <span className="ml-auto text-[12px] text-muted">{rows.length} enrollments</span>
      </div>
      {loading ? (
        <div className="p-6 text-[13px] text-muted">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="p-4"><EmptyState title="No enrollments" hint="Enroll leads from a sequence to get started." /></div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-xs font-semibold text-muted">
                <th className="px-3 py-2">Lead</th>
                <th className="px-3 py-2">Sequence</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Step</th>
                <th className="px-3 py-2">Next run</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((e) => (
                <tr key={e.id} className="hover:bg-hover-paper">
                  <td className="px-3 py-2">
                    <div className="font-medium text-ink">{e.lead.name}</div>
                    <div className="text-[12px] text-muted">{[e.lead.company, e.lead.email].filter(Boolean).join(" · ") || "—"}</div>
                  </td>
                  <td className="px-3 py-2 text-muted">{e.sequence.name}</td>
                  <td className="px-3 py-2"><Chip>{e.status}</Chip></td>
                  <td className="px-3 py-2 text-muted">{e.status === "completed" ? "done" : `${e.currentStep + 1}`}</td>
                  <td className="px-3 py-2 text-muted">{e.nextRunAt ? timeAgo(e.nextRunAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ── Approvals tab ─────────────────────────────────────────────── */

function ApprovalsTab() {
  const [items, setItems] = useState<ApprovalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ items: ApprovalRow[] }>("/api/nurture/approvals?status=pending&limit=100");
      setItems(data.items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const decide = async (id: string, action: "approve" | "reject") => {
    setBusy(id);
    try {
      await api(`/api/nurture/approvals/${id}/${action}`, {
        method: "POST",
        body: JSON.stringify({ note: note[id]?.trim() || undefined }),
      });
      setItems((prev) => prev.filter((i) => i.id !== id));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-[12px] text-muted">
        Every sequence and speed-to-lead send waits here. Approving releases the message to the dispatcher
        (consent, quiet hours, caps, and dedup are enforced at dispatch).
      </p>
      {loading ? (
        <div className="rounded-lg bg-paper p-6 text-[13px] text-muted shadow-hairline">Loading…</div>
      ) : items.length === 0 ? (
        <EmptyState title="Approval queue is clear" hint="New sequence sends will appear here as the engine advances." />
      ) : items.map((item) => {
        const p = item.payload ?? {};
        return (
          <div key={item.id} className="rounded-lg bg-paper p-3 shadow-hairline">
            <div className="flex flex-wrap items-center gap-2">
              <ChannelChip channel={String(p.channel ?? "sms")} />
              {item.status === "pending" ? (
                <NeedsBadge>{item.status}</NeedsBadge>
              ) : item.status === "approved" ? (
                <DoneBadge>{item.status}</DoneBadge>
              ) : (
                <Chip>{item.status}</Chip>
              )}
              <Chip>{String(item.kind).replace(/_/g, " ")}</Chip>
              <span className="text-[13px] font-medium text-ink">
                {item.lead ? `${item.lead.name}${item.lead.company ? ` — ${item.lead.company}` : ""}` : "—"}
              </span>
              <span className="ml-auto text-[12px] text-subtle">
                step {(Number(p.stepIndex ?? 0)) + 1} · requested {timeAgo(item.createdAt)}
                {item.requestedBy ? ` by ${item.requestedBy}` : ""}
              </span>
            </div>
            {p.subject ? <p className="mt-2 text-[13px] font-medium text-ink">Subject: {String(p.subject)}</p> : null}
            <p className="aos-mono mt-1 whitespace-pre-wrap break-words rounded-md bg-canvas p-2 text-[12px] leading-5 text-muted">
              {String(p.body ?? "")}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                className={`${inputCls} max-w-xs`}
                value={note[item.id] ?? ""}
                onChange={(e) => setNote((n) => ({ ...n, [item.id]: e.target.value }))}
                placeholder="Decision note (optional)…"
              />
              <button className={btnApprove} disabled={busy === item.id} onClick={() => decide(item.id, "approve")}>
                <Check size={14} /> {busy === item.id ? "…" : "Approve"}
              </button>
              <button className={btnDanger} disabled={busy === item.id} onClick={() => decide(item.id, "reject")}>
                <X size={14} /> {busy === item.id ? "…" : "Reject"}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Message log tab ───────────────────────────────────────────── */

function MessageLogTab() {
  const [rows, setRows] = useState<OutboundMessageRow[]>([]);
  const [channel, setChannel] = useState("");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const sp = new URLSearchParams({ limit: "100" });
      if (channel) sp.set("channel", channel);
      if (status) sp.set("status", status);
      if (q.trim()) sp.set("q", q.trim());
      const data = await api<{ messages: OutboundMessageRow[] }>(`/api/nurture/log?${sp}`);
      setRows(data.messages);
    } finally {
      setLoading(false);
    }
  }, [channel, status, q]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="rounded-lg bg-paper shadow-hairline">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <select className={`${inputCls} w-32`} value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="">All channels</option>
          <option value="sms">SMS</option>
          <option value="email">Email</option>
          <option value="voice">Voice</option>
          <option value="postcard">Postcard</option>
          <option value="letter">Letter</option>
        </select>
        <select className={`${inputCls} w-36`} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {["queued", "sent", "delivered", "failed", "suppressed"].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
          <input className={`${inputCls} pl-8`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search body or lead…" />
        </div>
        <span className="ml-auto text-[12px] text-muted">{rows.length} messages</span>
      </div>
      {loading ? (
        <div className="p-6 text-[13px] text-muted">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="p-4"><EmptyState title="No messages yet" hint="Run the engine or approve a queued send to populate the ledger." /></div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-xs font-semibold text-muted">
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Lead</th>
                <th className="px-3 py-2">Channel</th>
                <th className="px-3 py-2">Kind</th>
                <th className="px-3 py-2">Preview</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((m) => (
                <tr key={m.id} className="hover:bg-hover-paper">
                  <td className="whitespace-nowrap px-3 py-2 text-[12px] text-muted">{timeAgo(m.createdAt)}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-ink">{m.lead?.name ?? "—"}</div>
                    <div className="text-[12px] text-muted">{m.lead?.company ?? ""}</div>
                  </td>
                  <td className="px-3 py-2"><ChannelChip channel={m.channel} /></td>
                  <td className="px-3 py-2 text-[12px] text-muted">{m.kind.replace(/_/g, " ")}</td>
                  <td className="max-w-[280px] px-3 py-2">
                    <button
                      className="block w-full truncate text-left text-[12px] text-muted hover:text-ink"
                      onClick={() => setExpanded(expanded === m.id ? null : m.id)}
                      title="Click to expand"
                    >
                      {m.subject ? <span className="font-medium text-muted">“{m.subject}” — </span> : null}
                      {m.body}
                    </button>
                    {expanded === m.id ? (
                      <div className="aos-mono mt-1 whitespace-pre-wrap break-words rounded-md bg-canvas p-2 text-[12px] text-muted">
                        {m.body}
                        {m.error ? <p className="mt-1 text-failed-text">Error: {m.error}</p> : null}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <Chip title={m.status === "suppressed" ? `Reason: ${m.suppressionReason ?? "unknown"}` : undefined}>
                      {m.status === "suppressed" ? `suppressed: ${m.suppressionReason ?? "?"}` : m.status}
                    </Chip>
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

/* ── Consent tab ─────────────────────────────────────────────────── */

const CONSENT_OPTIONS = ["unknown", "pending", "opted_in", "opted_out"] as const;

function ConsentTab() {
  const [rows, setRows] = useState<ConsentRow[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const sp = new URLSearchParams({ limit: "100" });
      if (q.trim()) sp.set("q", q.trim());
      const data = await api<{ leads: ConsentRow[] }>(`/api/nurture/consent?${sp}`);
      setRows(data.leads);
    } finally {
      setLoading(false);
    }
  }, [q]);

  useEffect(() => { load(); }, [load]);

  const setConsent = async (leadId: string, channel: "sms" | "email" | "voice" | "mail", status: string) => {
    await api("/api/nurture/consent", {
      method: "POST",
      body: JSON.stringify({ leadId, channel, status, source: "manual" }),
    });
    setRows((prev) => prev.map((r) => (r.id === leadId ? { ...r, consent: { ...r.consent, [channel]: status } } : r)));
  };

  return (
    <div className="rounded-lg bg-paper shadow-hairline">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
          <input className={`${inputCls} pl-8`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search leads…" />
        </div>
        <span className="ml-auto text-[12px] text-muted">
          Click a channel status to change it. The dispatcher suppresses sends without consent.
        </span>
      </div>
      {loading ? (
        <div className="p-6 text-[13px] text-muted">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="p-4"><EmptyState title="No leads" hint="Leads appear here once added to the CRM." /></div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-xs font-semibold text-muted">
                <th className="px-3 py-2">Lead</th>
                <th className="px-3 py-2">SMS</th>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Voice</th>
                <th className="px-3 py-2">Mail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-hover-paper">
                  <td className="px-3 py-2">
                    <div className="font-medium text-ink">{r.name}</div>
                    <div className="text-[12px] text-muted">{[r.company, r.email].filter(Boolean).join(" · ") || "—"}</div>
                  </td>
                  {(["sms", "email", "voice", "mail"] as const).map((ch) => (
                    <td key={ch} className="px-3 py-2">
                      <select
                        className="rounded-full border border-line bg-paper px-2 py-0.5 text-[12px] font-medium text-ink focus:outline-none"
                        value={r.consent[ch] ?? "unknown"}
                        onChange={(e) => setConsent(r.id, ch, e.target.value)}
                      >
                        {CONSENT_OPTIONS.map((o) => (
                          <option key={o} value={o}>{o.replace("_", " ")}</option>
                        ))}
                      </select>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
