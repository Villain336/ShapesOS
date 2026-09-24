// Marketr — Calls dashboard (R5).
// Light mode, CRM density: tracking numbers, call log, booking pages,
// bookings. Read from /api/calls/*.

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  PhoneCall,
  Phone,
  CalendarBlank,
  CalendarPlus,
  Plus,
  Trash,
  X,
  Link as LinkIcon,
  Check,
  Copy,
  Code,
} from "@phosphor-icons/react";
import { EmptyState } from "../crm/ui";
import { formatMoney } from "../crm/types";

const cardCls = "rounded-[10px] border border-stone-200 bg-white p-4";
const thCls = "px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-stone-500";
const tdCls = "px-3 py-2.5 text-[13px] text-stone-700 tabular-nums";
const tdNum = "px-3 py-2.5 text-[13px] text-stone-700 tabular-nums text-right";
const thNum = "px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-stone-500";

type Tab = "numbers" | "calls" | "pages" | "bookings";

const TABS: { id: Tab; label: string }[] = [
  { id: "numbers", label: "Numbers" },
  { id: "calls", label: "Call log" },
  { id: "pages", label: "Booking pages" },
  { id: "bookings", label: "Bookings" },
];

interface CallNumberRow {
  id: string; e164: string; provider: string; providerSid: string | null;
  friendlyName: string | null; campaign: string | null; status: string;
  _count: { calls: number };
}
interface CallRow {
  id: string; from: string; to: string; direction: string; status: string;
  startedAt: string; durationSec: number; recordingUrl: string | null;
  transcription: string | null; summary: string | null;
  number: { e164: string; friendlyName: string | null; campaign: string | null };
  lead: { id: string; name: string; phone: string | null } | null;
}
interface BookingPageRow {
  id: string; slug: string; title: string; description: string | null;
  enabled: boolean; settings: Record<string, unknown>; _count: { bookings: number };
}
interface BookingRow {
  id: string; name: string; email: string | null; phone: string | null;
  startAt: string; endAt: string; status: string; consentGiven: boolean;
  remindersOptedOut: boolean; remindersSent: number;
  page: { title: string; slug: string };
  lead: { id: string; name: string } | null;
}

function fmtDur(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}
function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function statusChip(status: string): string {
  const base = "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium";
  if (status === "active" || status === "completed" || status === "scheduled") return `${base} bg-emerald-50 text-emerald-700`;
  if (status === "missed") return `${base} bg-amber-50 text-amber-700`;
  if (status === "released" || status === "cancelled" || status === "failed") return `${base} bg-stone-100 text-stone-500`;
  return `${base} bg-sky-50 text-sky-700`;
}

export function CallsApp() {
  const [tab, setTab] = useState<Tab>("numbers");
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-stone-200 bg-white px-5 pb-0 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[12px] font-medium text-stone-500">Marketr · R5</div>
            <h1 className="text-[20px] font-semibold tracking-tight text-stone-900">Calls & Booking</h1>
          </div>
        </div>
        <div className="mt-3 flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-t-[8px] border-b-2 px-3.5 py-2 text-[13px] font-medium transition-colors ${
                tab === t.id ? "border-violet-600 text-violet-700" : "border-transparent text-stone-500 hover:text-stone-800"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-5">
          {tab === "numbers" && <NumbersPanel />}
          {tab === "calls" && <CallsPanel />}
          {tab === "pages" && <PagesPanel />}
          {tab === "bookings" && <BookingsPanel />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

function NumbersPanel() {
  const [numbers, setNumbers] = useState<CallNumberRow[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [loading, setLoading] = useState(true);
  const [showPurchase, setShowPurchase] = useState(false);
  const [areaCode, setAreaCode] = useState("");
  const [friendlyName, setFriendlyName] = useState("");
  const [campaign, setCampaign] = useState("");
  const [purchasing, setPurchasing] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/calls/numbers");
      const d = await r.json();
      setNumbers(d.numbers ?? []);
      setWorkspaceId(d.workspaceId ?? "");
    } catch { /* ignore */ }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function purchase() {
    setPurchasing(true);
    setError("");
    try {
      const r = await fetch("/api/calls/numbers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          areaCode: areaCode || undefined,
          friendlyName: friendlyName || undefined,
          campaign: campaign || undefined,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Purchase failed");
      setShowPurchase(false);
      setAreaCode(""); setFriendlyName(""); setCampaign("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Purchase failed");
    }
    setPurchasing(false);
  }

  async function release(id: string) {
    if (!confirm("Release this number? It will stop tracking calls immediately.")) return;
    await fetch(`/api/calls/numbers/${id}`, { method: "DELETE" });
    await load();
  }

  const snippet = `<script src="${typeof window !== "undefined" ? window.location.origin : ""}/api/calls/dni/snippet?workspace=${workspaceId}"></script>`;

  return (
    <div className="flex flex-col gap-5">
      <section className={cardCls}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-[14px] font-semibold text-stone-900">
            <Phone size={16} className="text-violet-600" /> Tracking numbers
          </h2>
          <button onClick={() => setShowPurchase(true)} className="crm-btn-primary flex items-center gap-1.5 !py-[7px] !text-[12.5px]">
            <Plus size={14} /> Buy number
          </button>
        </div>
        {loading ? (
          <p className="py-8 text-center text-sm text-stone-500">Loading numbers…</p>
        ) : numbers.length === 0 ? (
          <EmptyState icon={Phone} title="No tracking numbers yet" hint="Buy a number to start attributing calls to campaigns." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead><tr className="border-b border-stone-200">
                <th className={thCls}>Number</th><th className={thCls}>Name</th><th className={thCls}>Campaign</th>
                <th className={thCls}>Status</th><th className={thNum}>Calls</th><th className={thCls}></th>
              </tr></thead>
              <tbody>
                {numbers.map((n) => (
                  <tr key={n.id} className="border-b border-stone-100 last:border-0">
                    <td className={`${tdCls} font-medium text-stone-900`}>{n.e164}</td>
                    <td className={tdCls}>{n.friendlyName ?? "—"}</td>
                    <td className={tdCls}>{n.campaign ?? "—"}</td>
                    <td className={tdCls}><span className={statusChip(n.status)}>{n.status}</span></td>
                    <td className={tdNum}>{n._count.calls}</td>
                    <td className={tdCls}>
                      {n.status === "active" && (
                        <button onClick={() => release(n.id)} className="crm-btn-ghost !px-2 !py-1 !text-[12px]" title="Release number">
                          <Trash size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {error && <p className="mt-3 text-[13px] text-red-600">{error}</p>}
      </section>

      <section className={cardCls}>
        <h2 className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-stone-900">
          <Code size={16} className="text-violet-600" /> Dynamic number insertion
        </h2>
        <p className="mb-3 max-w-[640px] text-[13px] text-stone-600">
          Paste this snippet on your site. It reads <code className="rounded bg-stone-100 px-1">?utm_source=</code> from
          the URL and swaps every <code className="rounded bg-stone-100 px-1">tel:</code> link and
          <code className="rounded bg-stone-100 px-1">[data-mk-number]</code> element to the tracking number
          whose campaign matches — falling back to your first active number.
        </p>
        <div className="flex items-start gap-2">
          <code className="flex-1 break-all rounded-[8px] bg-stone-900 px-3 py-2.5 font-mono text-[12px] text-stone-100">{snippet}</code>
          <button
            onClick={() => { navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
            className="crm-btn-ghost flex items-center gap-1.5 !py-[7px] !text-[12.5px]"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </section>

      {showPurchase && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4" onClick={() => setShowPurchase(false)}>
          <div className="w-full max-w-[420px] rounded-[12px] bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-[15px] font-semibold text-stone-900">Buy tracking number</h3>
              <button onClick={() => setShowPurchase(false)} className="crm-btn-ghost !p-1.5"><X size={16} /></button>
            </div>
            <label className="mb-3 block">
              <span className="mb-1 block text-[12px] font-medium text-stone-600">Area code (optional)</span>
              <input value={areaCode} onChange={(e) => setAreaCode(e.target.value)} placeholder="919" className="crm-input w-full" />
            </label>
            <label className="mb-3 block">
              <span className="mb-1 block text-[12px] font-medium text-stone-600">Friendly name</span>
              <input value={friendlyName} onChange={(e) => setFriendlyName(e.target.value)} placeholder="Summer campaign line" className="crm-input w-full" />
            </label>
            <label className="mb-4 block">
              <span className="mb-1 block text-[12px] font-medium text-stone-600">Campaign label (for DNI + attribution)</span>
              <input value={campaign} onChange={(e) => setCampaign(e.target.value)} placeholder="summer-sale" className="crm-input w-full" />
            </label>
            {error && <p className="mb-3 text-[13px] text-red-600">{error}</p>}
            <button onClick={purchase} disabled={purchasing} className="crm-btn-primary w-full">
              {purchasing ? "Purchasing…" : "Buy number"}
            </button>
            <p className="mt-3 text-[11.5px] text-stone-400">Runs on the fake telephony provider until Twilio credentials are configured.</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Call log
// ---------------------------------------------------------------------------

function CallsPanel() {
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/calls/calls?limit=100${status ? `&status=${status}` : ""}`);
      const d = await r.json();
      setCalls(d.calls ?? []);
    } catch { /* ignore */ }
    setLoading(false);
  }, [status]);
  useEffect(() => { load(); }, [load]);

  return (
    <section className={cardCls}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-[14px] font-semibold text-stone-900">
          <PhoneCall size={16} className="text-violet-600" /> Call log
        </h2>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="crm-select !py-[6px] !text-[12.5px]" aria-label="Status filter">
          <option value="">All statuses</option>
          <option value="completed">Completed</option>
          <option value="missed">Missed</option>
          <option value="voicemail">Voicemail</option>
          <option value="in_progress">In progress</option>
        </select>
      </div>
      {loading ? (
        <p className="py-8 text-center text-sm text-stone-500">Loading calls…</p>
      ) : calls.length === 0 ? (
        <EmptyState icon={PhoneCall} title="No calls yet" hint="Inbound calls to your tracking numbers appear here with summaries and lead links." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead><tr className="border-b border-stone-200">
              <th className={thCls}>When</th><th className={thCls}>Caller</th><th className={thCls}>Number</th>
              <th className={thNum}>Duration</th><th className={thCls}>Status</th><th className={thCls}>Lead</th>
            </tr></thead>
            <tbody>
              {calls.map((c) => (
                <>
                  <tr key={c.id} className="cursor-pointer border-b border-stone-100 last:border-0 hover:bg-stone-50" onClick={() => setExpanded(expanded === c.id ? null : c.id)}>
                    <td className={tdCls}>{fmtDateTime(c.startedAt)}</td>
                    <td className={`${tdCls} font-medium text-stone-900`}>{c.from}</td>
                    <td className={tdCls}>{c.number.friendlyName ?? c.number.e164}</td>
                    <td className={tdNum}>{fmtDur(c.durationSec)}</td>
                    <td className={tdCls}><span className={statusChip(c.status)}>{c.status.replace("_", " ")}</span></td>
                    <td className={tdCls}>
                      {c.lead ? (
                        <a href={`/dashboard/crm?lead=${c.lead.id}`} className="text-violet-700 hover:underline" onClick={(e) => e.stopPropagation()}>
                          {c.lead.name}
                        </a>
                      ) : "—"}
                    </td>
                  </tr>
                  {expanded === c.id && (
                    <tr key={`${c.id}-x`} className="border-b border-stone-100 bg-stone-50/60">
                      <td colSpan={6} className="px-4 py-3">
                        <p className="mb-2 text-[13px] text-stone-700"><span className="font-semibold">Summary: </span>{c.summary ?? "—"}</p>
                        {c.transcription && (
                          <pre className="max-h-[160px] overflow-y-auto whitespace-pre-wrap rounded-[8px] bg-white p-3 font-mono text-[12px] text-stone-600">{c.transcription}</pre>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Booking pages
// ---------------------------------------------------------------------------

function PagesPanel() {
  const [pages, setPages] = useState<BookingPageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [durationMin, setDurationMin] = useState("30");
  const [timezone, setTimezone] = useState("America/New_York");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/calls/booking-pages");
      const d = await r.json();
      setPages(d.pages ?? []);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function create() {
    setCreating(true);
    setError("");
    try {
      const r = await fetch("/api/calls/booking-pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, slug, settings: { durationMin: Number(durationMin) || 30, timezone } }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Create failed");
      setNewToken(d.token);
      setTitle(""); setSlug("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    }
    setCreating(false);
  }

  async function toggle(p: BookingPageRow) {
    await fetch(`/api/calls/booking-pages/${p.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !p.enabled }),
    });
    await load();
  }
  async function remove(id: string) {
    if (!confirm("Delete this booking page and all its bookings?")) return;
    await fetch(`/api/calls/booking-pages/${id}`, { method: "DELETE" });
    await load();
  }

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <div className="flex flex-col gap-5">
      {newToken && (
        <div className="rounded-[10px] border border-violet-200 bg-violet-50 px-4 py-3">
          <p className="mb-1 text-[13px] font-semibold text-violet-900">Booking page created — save this token now, it won't be shown again:</p>
          <div className="flex items-start gap-2">
            <code className="flex-1 break-all rounded-[8px] bg-stone-900 px-3 py-2 font-mono text-[12px] text-stone-100">{newToken}</code>
            <button onClick={() => { navigator.clipboard.writeText(newToken); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className="crm-btn-ghost flex items-center gap-1.5 !py-[7px] !text-[12.5px]">
              {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}
            </button>
            <button onClick={() => setNewToken(null)} className="crm-btn-ghost !p-2"><X size={14} /></button>
          </div>
          <p className="mt-2 text-[12px] text-violet-700">Public page: <code className="rounded bg-violet-100 px-1">{origin}/book/{newToken}</code></p>
        </div>
      )}
      <section className={cardCls}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-[14px] font-semibold text-stone-900">
            <CalendarPlus size={16} className="text-violet-600" /> Booking pages
          </h2>
          <button onClick={() => setShowCreate(true)} className="crm-btn-primary flex items-center gap-1.5 !py-[7px] !text-[12.5px]">
            <Plus size={14} /> New page
          </button>
        </div>
        {loading ? (
          <p className="py-8 text-center text-sm text-stone-500">Loading pages…</p>
        ) : pages.length === 0 ? (
          <EmptyState icon={CalendarPlus} title="No booking pages yet" hint="Create a public booking page to let prospects schedule time with you." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead><tr className="border-b border-stone-200">
                <th className={thCls}>Title</th><th className={thCls}>Public link</th>
                <th className={thNum}>Bookings</th><th className={thCls}>Status</th><th className={thCls}></th>
              </tr></thead>
              <tbody>
                {pages.map((p) => (
                  <tr key={p.id} className="border-b border-stone-100 last:border-0">
                    <td className={`${tdCls} font-medium text-stone-900`}>{p.title}</td>
                    <td className={tdCls}>
                      <span className="flex items-center gap-1.5 text-violet-700">
                        <LinkIcon size={13} />
                        <span className="font-mono text-[12px]">{origin}/book/…</span>
                      </span>
                    </td>
                    <td className={tdNum}>{p._count.bookings}</td>
                    <td className={tdCls}><span className={statusChip(p.enabled ? "scheduled" : "cancelled")}>{p.enabled ? "Live" : "Disabled"}</span></td>
                    <td className={`${tdCls} whitespace-nowrap`}>
                      <button onClick={() => toggle(p)} className="crm-btn-ghost !px-2 !py-1 !text-[12px]">{p.enabled ? "Disable" : "Enable"}</button>
                      <button onClick={() => remove(p.id)} className="crm-btn-ghost !px-2 !py-1 !text-[12px]" title="Delete"><Trash size={14} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4" onClick={() => setShowCreate(false)}>
          <div className="w-full max-w-[420px] rounded-[12px] bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-[15px] font-semibold text-stone-900">New booking page</h3>
              <button onClick={() => setShowCreate(false)} className="crm-btn-ghost !p-1.5"><X size={16} /></button>
            </div>
            <label className="mb-3 block">
              <span className="mb-1 block text-[12px] font-medium text-stone-600">Title</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Free consultation" className="crm-input w-full" />
            </label>
            <label className="mb-3 block">
              <span className="mb-1 block text-[12px] font-medium text-stone-600">Slug</span>
              <input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} placeholder="free-consultation" className="crm-input w-full" />
            </label>
            <div className="mb-4 grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-[12px] font-medium text-stone-600">Duration (min)</span>
                <input value={durationMin} onChange={(e) => setDurationMin(e.target.value)} inputMode="numeric" className="crm-input w-full" />
              </label>
              <label className="block">
                <span className="mb-1 block text-[12px] font-medium text-stone-600">Timezone</span>
                <input value={timezone} onChange={(e) => setTimezone(e.target.value)} className="crm-input w-full" />
              </label>
            </div>
            {error && <p className="mb-3 text-[13px] text-red-600">{error}</p>}
            <button onClick={create} disabled={creating || !title || !slug} className="crm-btn-primary w-full">
              {creating ? "Creating…" : "Create page"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

function BookingsPanel() {
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/calls/bookings?limit=100${status ? `&status=${status}` : ""}`);
      const d = await r.json();
      setBookings(d.bookings ?? []);
    } catch { /* ignore */ }
    setLoading(false);
  }, [status]);
  useEffect(() => { load(); }, [load]);

  async function cancel(id: string) {
    if (!confirm("Cancel this booking? Pending reminders will be suppressed.")) return;
    await fetch(`/api/calls/bookings/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "cancelled" }),
    });
    await load();
  }

  return (
    <section className={cardCls}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-[14px] font-semibold text-stone-900">
          <CalendarBlank size={16} className="text-violet-600" /> Bookings
        </h2>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="crm-select !py-[6px] !text-[12.5px]" aria-label="Status filter">
          <option value="">All statuses</option>
          <option value="scheduled">Scheduled</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>
      {loading ? (
        <p className="py-8 text-center text-sm text-stone-500">Loading bookings…</p>
      ) : bookings.length === 0 ? (
        <EmptyState icon={CalendarBlank} title="No bookings yet" hint="Bookings made through your public booking pages appear here." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead><tr className="border-b border-stone-200">
              <th className={thCls}>When</th><th className={thCls}>Name</th><th className={thCls}>Contact</th>
              <th className={thCls}>Page</th><th className={thCls}>Status</th><th className={thNum}>Reminders</th><th className={thCls}></th>
            </tr></thead>
            <tbody>
              {bookings.map((b) => (
                <tr key={b.id} className="border-b border-stone-100 last:border-0">
                  <td className={`${tdCls} font-medium text-stone-900`}>{fmtDateTime(b.startAt)}</td>
                  <td className={tdCls}>{b.name}</td>
                  <td className={tdCls}>{b.email ?? b.phone ?? "—"}</td>
                  <td className={tdCls}>{b.page.title}</td>
                  <td className={tdCls}>
                    <span className={statusChip(b.status)}>{b.status}</span>
                    {b.remindersOptedOut && <span className={`${statusChip("failed")} ml-1`}>opted out</span>}
                  </td>
                  <td className={tdNum}>{b.remindersSent}</td>
                  <td className={tdCls}>
                    {b.status === "scheduled" && (
                      <button onClick={() => cancel(b.id)} className="crm-btn-ghost !px-2 !py-1 !text-[12px]">Cancel</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
