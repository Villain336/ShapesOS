// Marketr — R4 review engine dashboard (client).
// Light mode, dense data-first: white/paper surfaces, violet accents, compact
// type, chips, Lucide icons. Tabs: Requests (config + funnel + send + table),
// Incoming reviews (AI draft replies + approval status).

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Star,
  Send,
  QrCode,
  Check,
  CheckCheck,
  Copy,
  Download,
  X,
  Sparkles,
  MessageSquareText,
  ExternalLink,
  Loader2,
  Settings2,
  Inbox,
  ListChecks,
  AlertTriangle,
  ShieldCheck,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Small primitives
// ---------------------------------------------------------------------------

const cardCls = "rounded-xl border border-stone-200 bg-white p-4";
const inputCls =
  "w-full rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500";
const btnPrimary =
  "inline-flex items-center gap-1.5 rounded-lg bg-violet-700 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-violet-800 disabled:opacity-60";
const btnGhost =
  "inline-flex items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-[12.5px] font-medium text-stone-700 hover:border-violet-300 hover:text-violet-700 disabled:opacity-60";

function Chip({ tone, children }: { tone: "violet" | "emerald" | "sky" | "stone" | "amber" | "rose"; children: React.ReactNode }) {
  const tones: Record<string, string> = {
    violet: "bg-violet-50 text-violet-700 ring-violet-200",
    emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    sky: "bg-sky-50 text-sky-700 ring-sky-200",
    stone: "bg-stone-100 text-stone-600 ring-stone-200",
    amber: "bg-amber-50 text-amber-700 ring-amber-200",
    rose: "bg-rose-50 text-rose-700 ring-rose-200",
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${tones[tone]}`}>
      {children}
    </span>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="rounded p-1 text-stone-400 hover:text-violet-700"
      title={`Copy ${label}`}
      aria-label={`Copy ${label}`}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch { /* clipboard unavailable */ }
      }}
    >
      {copied ? <Check size={13} className="text-emerald-600" /> : <Copy size={13} />}
    </button>
  );
}

function Stars({ n }: { n: number | null }) {
  if (n == null) return <span className="text-[12px] text-stone-400">—</span>;
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${n} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          size={12}
          className={i <= n ? "text-amber-400" : "text-stone-200"}
          fill="currentColor"
          strokeWidth={0}
        />
      ))}
    </span>
  );
}

function fmtDate(v: string | null): string {
  if (!v) return "—";
  return new Date(v).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SiteConfig {
  id: string;
  site: string;
  reviewUrl: string;
  delayDays: number;
  enabled: boolean;
}

interface ReviewRequestRow {
  id: string;
  leadId: string;
  token: string;
  channel: string;
  status: string;
  reviewUrl: string | null;
  messageId: string | null;
  sentAt: string;
  viewedAt: string | null;
  completedAt: string | null;
  expiresAt: string | null;
  pageUrl: string;
  lead: { id: string; name: string; email: string | null; phone: string | null };
}

interface FunnelStats {
  sent: number;
  viewed: number;
  completed: number;
  expired: number;
  viewRate: number;
  completionRate: number;
  completedOfViewed: number;
}

interface IncomingReview {
  id: string;
  businessName: string;
  author: string | null;
  rating: number | null;
  text: string | null;
  publishedAt: string | null;
  sentiment: string;
  approvalStatus: string | null;
  approvalId: string | null;
}

interface LeadHit {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
}

// ---------------------------------------------------------------------------
// Config card
// ---------------------------------------------------------------------------

function ConfigCard({ onSaved }: { onSaved: () => void }) {
  const [configs, setConfigs] = useState<SiteConfig[]>([]);
  const [site, setSite] = useState("google");
  const [reviewUrl, setReviewUrl] = useState("");
  const [delayDays, setDelayDays] = useState(1);
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const r = await fetch("/api/review-config");
    if (r.ok) {
      const j = await r.json();
      setConfigs(j.configs);
      const g = (j.configs as SiteConfig[]).find((c) => c.site === "google");
      if (g) {
        setReviewUrl(g.reviewUrl);
        setDelayDays(g.delayDays);
        setEnabled(g.enabled);
      }
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const c = configs.find((x) => x.site === site);
    if (c) {
      setReviewUrl(c.reviewUrl);
      setDelayDays(c.delayDays);
      setEnabled(c.enabled);
    } else {
      setReviewUrl("");
      setDelayDays(1);
      setEnabled(true);
    }
  }, [site, configs]);

  async function save() {
    setSaving(true);
    setMsg("");
    try {
      const r = await fetch("/api/review-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ site, reviewUrl, delayDays, enabled }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Save failed");
      setMsg("Saved.");
      load();
      onSaved();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={cardCls}>
      <div className="mb-3 flex items-center gap-2">
        <Settings2 size={15} className="text-violet-700" />
        <h2 className="text-[13px] font-semibold text-stone-900">Review site config</h2>
        {configs.filter((c) => c.enabled).length > 0 && (
          <Chip tone="emerald">{configs.filter((c) => c.enabled).length} enabled</Chip>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-[140px_1fr_110px_auto]">
        <select value={site} onChange={(e) => setSite(e.target.value)} className={inputCls} aria-label="Review site">
          {["google", "facebook", "yelp", "custom"].map((s) => (
            <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>
          ))}
        </select>
        <input
          value={reviewUrl}
          onChange={(e) => setReviewUrl(e.target.value)}
          placeholder="https://www.google.com/maps/… (your Google review link)"
          className={inputCls}
          inputMode="url"
        />
        <label className="flex items-center gap-1.5 text-[12px] text-stone-500">
          <input
            type="number"
            min={0}
            max={90}
            value={delayDays}
            onChange={(e) => setDelayDays(Number(e.target.value))}
            className={`${inputCls} w-16`}
            aria-label="Delay days"
          />
          day delay
        </label>
        <label className="flex items-center gap-1.5 text-[12.5px] font-medium text-stone-700">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 accent-violet-700"
          />
          Enabled
        </label>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button onClick={save} disabled={saving || !reviewUrl.trim()} className={btnPrimary}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save config
        </button>
        {msg && <span className="text-[12px] text-stone-500">{msg}</span>}
      </div>
      <p className="mt-2 text-[11.5px] leading-relaxed text-stone-400">
        Google is the default send target. Requests go out after the delay via the messaging
        approval queue — every send is manual-approved and consent-gated.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Funnel
// ---------------------------------------------------------------------------

function FunnelCard({ stats }: { stats: FunnelStats | null }) {
  const cells = [
    { label: "Sent", value: stats?.sent ?? 0, icon: Send, tone: "text-stone-500" },
    { label: "Viewed", value: stats?.viewed ?? 0, icon: Inbox, tone: "text-sky-600" },
    { label: "Completed", value: stats?.completed ?? 0, icon: CheckCheck, tone: "text-emerald-600" },
    { label: "Expired", value: stats?.expired ?? 0, icon: AlertTriangle, tone: "text-amber-600" },
  ];
  return (
    <section className={cardCls}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold text-stone-900">Request funnel</h2>
        {stats && (
          <div className="flex items-center gap-1.5">
            <Chip tone="sky">view {stats.viewRate}%</Chip>
            <Chip tone="emerald">complete {stats.completionRate}%</Chip>
            <Chip tone="violet">viewed→done {stats.completedOfViewed}%</Chip>
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {cells.map((c) => (
          <div key={c.label} className="rounded-lg bg-stone-50 px-3 py-2.5">
            <div className={`flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide ${c.tone}`}>
              <c.icon size={13} /> {c.label}
            </div>
            <div className="mt-1 text-[22px] font-semibold tracking-tight text-stone-900">{c.value}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Send form
// ---------------------------------------------------------------------------

function SendCard({ onSent }: { onSent: () => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<LeadHit[]>([]);
  const [open, setOpen] = useState(false);
  const [lead, setLead] = useState<LeadHit | null>(null);
  const [channel, setChannel] = useState<"sms" | "email">("sms");
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(async () => {
      if (!q.trim() || lead) { setHits([]); return; }
      const r = await fetch(`/api/crm/leads?q=${encodeURIComponent(q.trim())}&limit=8`);
      if (r.ok) {
        const j = await r.json();
        setHits((j.leads ?? j.items ?? []).map((l: LeadHit) => ({
          id: l.id, name: l.name, email: l.email, phone: l.phone,
        })));
        setOpen(true);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q, lead]);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  async function send() {
    if (!lead) return;
    setSending(true);
    setMsg(null);
    try {
      const r = await fetch("/api/review-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leadId: lead.id, channel }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.code === "suppressed" ? `Suppressed — ${j.error}` : (j.error || "Send failed"));
      setMsg({ tone: "ok", text: `Queued for approval (${channel.toUpperCase()}). Approval ${j.approvalId.slice(0, 8)}…` });
      setLead(null);
      setQ("");
      onSent();
    } catch (e) {
      setMsg({ tone: "err", text: e instanceof Error ? e.message : "Send failed" });
    } finally {
      setSending(false);
    }
  }

  return (
    <section className={cardCls}>
      <div className="mb-3 flex items-center gap-2">
        <Send size={15} className="text-violet-700" />
        <h2 className="text-[13px] font-semibold text-stone-900">Send review request</h2>
      </div>
      <div className="relative" ref={boxRef}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <input
              value={lead ? lead.name : q}
              onChange={(e) => { setQ(e.target.value); setLead(null); }}
              onFocus={() => { if (hits.length) setOpen(true); }}
              placeholder="Search leads by name, email, or phone…"
              className={inputCls}
            />
            {open && hits.length > 0 && !lead && (
              <div className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-stone-200 bg-white shadow-lg">
                {hits.map((h) => (
                  <button
                    key={h.id}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-violet-50"
                    onClick={() => { setLead(h); setOpen(false); }}
                  >
                    <span className="text-[13px] font-medium text-stone-900">{h.name}</span>
                    <span className="truncate text-[11.5px] text-stone-400">{h.phone || h.email || ""}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <select value={channel} onChange={(e) => setChannel(e.target.value as "sms" | "email")} className={`${inputCls} w-auto`} aria-label="Channel">
            <option value="sms">SMS</option>
            <option value="email">Email</option>
          </select>
          <button onClick={send} disabled={!lead || sending} className={btnPrimary}>
            {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Queue send
          </button>
        </div>
      </div>
      {lead && (
        <p className="mt-2 text-[12px] text-stone-500">
          To: <span className="font-medium text-stone-800">{lead.name}</span>
          {channel === "sms" ? ` · ${lead.phone || "no phone on file"}` : ` · ${lead.email || "no email on file"}`}
        </p>
      )}
      {msg && (
        <p className={`mt-2 flex items-start gap-1.5 text-[12.5px] ${msg.tone === "ok" ? "text-emerald-700" : "text-rose-700"}`}>
          {msg.tone === "ok" ? <ShieldCheck size={14} className="mt-0.5 shrink-0" /> : <AlertTriangle size={14} className="mt-0.5 shrink-0" />}
          {msg.text}
        </p>
      )}
      <p className="mt-2 text-[11.5px] text-stone-400">
        Sends are consent-gated and manual-approved. No consent on file → the send is suppressed and surfaced here.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Request table + QR modal
// ---------------------------------------------------------------------------

const STATUS_TONE: Record<string, "stone" | "sky" | "emerald" | "amber"> = {
  sent: "stone",
  viewed: "sky",
  completed: "emerald",
  expired: "amber",
};

function QrModal({ requestId, leadName, onClose }: { requestId: string; leadName: string; onClose: () => void }) {
  const [data, setData] = useState<{ qrDataUrl: string; pageUrl: string } | null>(null);
  useEffect(() => {
    fetch(`/api/review-requests/${requestId}/qr`)
      .then((r) => r.json())
      .then((j) => { if (j.qrDataUrl) setData(j); });
  }, [requestId]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/40 p-4" onClick={onClose}>
      <div className="w-full max-w-xs rounded-2xl bg-white p-5 text-center shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[13px] font-semibold text-stone-900">Print QR — {leadName}</h3>
          <button onClick={onClose} className="rounded p-1 text-stone-400 hover:text-stone-700" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {data ? (
          <>
            <img src={data.qrDataUrl} alt="Review QR code" className="mx-auto h-56 w-56 rounded-lg border border-stone-200" />
            <p className="mt-2 break-all text-[11px] text-stone-400">{data.pageUrl}</p>
            <a href={data.qrDataUrl} download={`review-qr-${requestId}.png`} className={`${btnPrimary} mt-3 w-full justify-center`}>
              <Download size={14} /> Download PNG
            </a>
          </>
        ) : (
          <div className="flex h-56 items-center justify-center">
            <Loader2 size={20} className="animate-spin text-stone-400" />
          </div>
        )}
      </div>
    </div>
  );
}

function RequestsTable({ refreshKey }: { refreshKey: number }) {
  const [rows, setRows] = useState<ReviewRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [qrFor, setQrFor] = useState<{ id: string; name: string } | null>(null);
  const [completing, setCompleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/review-requests?limit=100");
      if (r.ok) setRows((await r.json()).requests);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  async function markComplete(id: string) {
    setCompleting(id);
    try {
      const r = await fetch(`/api/review-requests/${id}/complete`, { method: "POST" });
      if (r.ok) load();
    } finally {
      setCompleting(null);
    }
  }

  return (
    <section className={cardCls}>
      <div className="mb-3 flex items-center gap-2">
        <ListChecks size={15} className="text-violet-700" />
        <h2 className="text-[13px] font-semibold text-stone-900">Requests</h2>
        <span className="text-[12px] text-stone-400">{rows.length}</span>
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-8"><Loader2 size={18} className="animate-spin text-stone-400" /></div>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-stone-400">No review requests yet. Queue one above or trigger one from a lead.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-[12.5px]">
            <thead>
              <tr className="border-b border-stone-100 text-[11px] font-semibold uppercase tracking-wide text-stone-400">
                <th className="px-2 py-2">Lead</th>
                <th className="px-2 py-2">Channel</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">Sent</th>
                <th className="px-2 py-2">Viewed</th>
                <th className="px-2 py-2">Completed</th>
                <th className="px-2 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-stone-50 hover:bg-stone-50/60">
                  <td className="px-2 py-2">
                    <div className="font-medium text-stone-900">{r.lead.name}</div>
                    <div className="text-[11px] text-stone-400">{r.channel === "sms" ? r.lead.phone : r.lead.email}</div>
                  </td>
                  <td className="px-2 py-2"><Chip tone="violet">{r.channel.toUpperCase()}</Chip></td>
                  <td className="px-2 py-2"><Chip tone={STATUS_TONE[r.status] ?? "stone"}>{r.status}</Chip></td>
                  <td className="px-2 py-2 text-stone-500">{fmtDate(r.sentAt)}</td>
                  <td className="px-2 py-2 text-stone-500">{fmtDate(r.viewedAt)}</td>
                  <td className="px-2 py-2 text-stone-500">{fmtDate(r.completedAt)}</td>
                  <td className="px-2 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <CopyButton value={r.pageUrl} label="review link" />
                      <button className={btnGhost} title="Show print QR" onClick={() => setQrFor({ id: r.id, name: r.lead.name })}>
                        <QrCode size={13} /> QR
                      </button>
                      {r.status !== "completed" && (
                        <button className={btnGhost} disabled={completing === r.id} onClick={() => markComplete(r.id)} title="Mark completed manually">
                          {completing === r.id ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Done
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {qrFor && <QrModal requestId={qrFor.id} leadName={qrFor.name} onClose={() => setQrFor(null)} />}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Incoming reviews tab
// ---------------------------------------------------------------------------

const SENTIMENT_TONE: Record<string, "emerald" | "stone" | "rose"> = {
  pos: "emerald",
  neu: "stone",
  neg: "rose",
};

function IncomingReviews() {
  const [reviews, setReviews] = useState<IncomingReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [drafting, setDrafting] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { body: string; approvalId: string; mock: boolean }>>({});
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/reviews/incoming");
      if (r.ok) setReviews((await r.json()).reviews);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function draft(id: string) {
    setDrafting(id);
    setErr("");
    try {
      const r = await fetch(`/api/reviews/${id}/draft-response`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Draft failed");
      setDrafts((d) => ({ ...d, [id]: { body: j.draftBody, approvalId: j.approvalId, mock: j.mock } }));
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Draft failed");
    } finally {
      setDrafting(null);
    }
  }

  if (loading) {
    return <div className="flex items-center justify-center py-10"><Loader2 size={18} className="animate-spin text-stone-400" /></div>;
  }

  return (
    <div className="space-y-3">
      <div className={`${cardCls} flex items-start gap-2 !border-violet-200 !bg-violet-50/50`}>
        <MessageSquareText size={15} className="mt-0.5 shrink-0 text-violet-700" />
        <p className="text-[12.5px] leading-relaxed text-stone-600">
          Drafts are AI-written and <span className="font-semibold">never posted automatically</span>.
          Each draft creates an approval item — approve it under{" "}
          <a href="/api/messaging/approvals" className="font-medium text-violet-700 underline">Messaging → Approvals</a>,
          then post the reply manually. Google auto-post requires GBP API approval, which is still pending.
        </p>
      </div>
      {err && <p className="text-[12.5px] text-rose-700">{err}</p>}
      {reviews.length === 0 && (
        <p className="py-10 text-center text-[13px] text-stone-400">No unanswered monitored reviews. New Google reviews needing a reply will appear here.</p>
      )}
      {reviews.map((rv) => {
        const d = drafts[rv.id];
        return (
          <article key={rv.id} className={cardCls}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-semibold text-stone-900">{rv.author || "Anonymous"}</span>
              <Stars n={rv.rating} />
              <Chip tone={SENTIMENT_TONE[rv.sentiment] ?? "stone"}>{rv.sentiment}</Chip>
              {rv.publishedAt && <span className="text-[11.5px] text-stone-400">{fmtDate(rv.publishedAt)}</span>}
              <span className="ml-auto">
                {rv.approvalStatus === "pending" ? (
                  <Chip tone="amber">draft awaiting approval</Chip>
                ) : rv.approvalStatus === "approved" ? (
                  <Chip tone="emerald">approved — post manually</Chip>
                ) : null}
              </span>
            </div>
            {rv.text && <p className="mt-2 text-[13px] leading-relaxed text-stone-600">{rv.text}</p>}
            <div className="mt-3">
              {d ? (
                <div className="rounded-lg border border-violet-200 bg-violet-50/60 p-3">
                  <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-violet-700">
                    <Sparkles size={12} /> AI draft {d.mock && <Chip tone="stone">mock LLM</Chip>}
                  </div>
                  <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-stone-800">{d.body}</p>
                  <p className="mt-2 text-[11.5px] text-stone-500">
                    Approval <span className="font-mono">{d.approvalId.slice(0, 8)}…</span> pending —{" "}
                    <a href="/api/messaging/approvals" className="font-medium text-violet-700 underline">open approvals</a>
                  </p>
                </div>
              ) : (
                <button onClick={() => draft(rv.id)} disabled={drafting === rv.id || rv.approvalStatus === "pending"} className={btnPrimary}>
                  {drafting === rv.id ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                  {rv.approvalStatus === "pending" ? "Draft pending approval" : "Draft AI response"}
                </button>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// App shell
// ---------------------------------------------------------------------------

export function ReviewsApp() {
  const [tab, setTab] = useState<"requests" | "incoming">("requests");
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight text-stone-900">Reviews</h1>
          <p className="text-[13px] text-stone-500">Review generation engine — requests, funnel, QR print, and AI reply drafts.</p>
        </div>
        <a href="/api/messaging/approvals" className={btnGhost} title="Messaging approval queue">
          <ExternalLink size={13} /> Approvals
        </a>
      </header>

      <nav className="flex gap-1 border-b border-stone-200" aria-label="Reviews sections">
        {(
          [
            { id: "requests", label: "Requests", icon: Send },
            { id: "incoming", label: "Incoming reviews", icon: Inbox },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium ${
              tab === t.id
                ? "border-violet-700 text-violet-800"
                : "border-transparent text-stone-500 hover:text-stone-800"
            }`}
          >
            <t.icon size={14} /> {t.label}
          </button>
        ))}
      </nav>

      {tab === "requests" ? (
        <div className="space-y-4">
          <FunnelSection refreshKey={refreshKey} />
          <ConfigCard onSaved={bump} />
          <SendCard onSent={bump} />
          <RequestsTable refreshKey={refreshKey} />
        </div>
      ) : (
        <IncomingReviews />
      )}
    </div>
  );
}

function FunnelSection({ refreshKey }: { refreshKey: number }) {
  const [stats, setStats] = useState<FunnelStats | null>(null);
  useEffect(() => {
    fetch("/api/review-requests?limit=1")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setStats(j.stats));
  }, [refreshKey]);
  return <FunnelCard stats={stats} />;
}
