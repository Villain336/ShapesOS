"use client";

// Marketr — Direct Mail dashboard: campaign list + detail, nurture mail
// pieces (R3 integration), and the campaign builder wizard.
//
// Consumes Track T1's live routes (app/api/mail/campaigns/**,
// app/api/mail/approvals/[id]) and the R3 nurture ledger
// (/api/mail-nurture/pieces, backed by T1's tables). Studio creative picker
// uses Track T2's /api/studio/creatives.
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Check,
  ChevronRight,
  FileText,
  Loader2,
  Mailbox,
  Plus,
  RefreshCw,
  ShieldCheck,
  Truck,
  X,
} from "lucide-react";

type Tab = "campaigns" | "pieces" | "builder";

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function api<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...opts, headers: { "content-type": "application/json", ...(opts?.headers ?? {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function StatusChip({ status }: { status: string }) {
  const tone =
    status === "delivered" || status === "complete" || status === "approved" || status === "valid"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : status === "sent" || status === "sending" || status === "corrected"
        ? "bg-sky-50 text-sky-700 border-sky-200"
        : status === "failed" || status === "rejected" || status === "cancelled" || status === "quarantined"
          ? "bg-red-50 text-red-700 border-red-200"
          : status === "queued" || status === "pending_approval" || status === "pending" || status === "draft"
            ? "bg-amber-50 text-amber-700 border-amber-200"
            : status === "suppressed"
              ? "bg-stone-100 text-stone-500 border-stone-200"
              : "bg-zinc-100 text-zinc-500 border-zinc-200";
  return (
    <span className={`inline-flex items-center rounded-full border px-1.5 py-px text-[11px] font-medium ${tone}`}>
      {status}
    </span>
  );
}

function VerifyChip({ status }: { status: string | null }) {
  if (!status) return <span className="text-[12px] text-stone-400">—</span>;
  const ok = status === "valid" || status === "corrected";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[11px] font-medium ${
        ok ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-red-50 text-red-700 border-red-200"
      }`}
    >
      {ok ? <BadgeCheck size={11} /> : <AlertTriangle size={11} />}
      {status}
    </span>
  );
}

const inputCls =
  "w-full rounded-md border border-stone-300 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-violet-500 focus:outline-none";
const btnPrimary =
  "inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-violet-700 disabled:opacity-50";
const btnSecondary =
  "inline-flex items-center gap-1.5 rounded-md border border-stone-300 bg-white px-3 py-1.5 text-[13px] font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function money(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

function ErrorBox({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="rounded-md border border-red-200 bg-red-50 p-2.5 text-[13px] text-red-700">{message}</div>;
}

// ---------------------------------------------------------------------------
// Campaigns tab (T1)
// ---------------------------------------------------------------------------

interface CampaignSummary {
  id: string;
  name: string;
  status: string;
  pieceCount?: number | null;
  verifiedCount?: number | null;
  quarantinedCount?: number | null;
  estCostCents?: number | null;
  actualCostCents?: number | null;
  inHomeStart?: string | null;
  inHomeEnd?: string | null;
  createdAt?: string;
  creative?: { id: string; name: string; formatTrack: string; size: string; status: string } | null;
  provider?: { id: string; provider: string; mode: string } | null;
}

interface MailApprovalRow {
  id: string;
  status: string;
  creativeHash: string | null;
  pieceCount: number;
  maxSpendCents: number;
  decidedAt: string | null;
  note: string | null;
}

interface CampaignDetail {
  campaign: CampaignSummary & { approvals: MailApprovalRow[] };
  pieces: Record<string, number>;
  verification: Record<string, number>;
}

function CampaignsTab({ onNew }: { onNew: () => void }) {
  const [campaigns, setCampaigns] = useState<CampaignSummary[] | null>(null);
  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api<{ campaigns: CampaignSummary[] }>("/api/mail/campaigns");
      setCampaigns(data.campaigns ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openDetail = async (id: string) => {
    setError(null);
    try {
      const data = await api<CampaignDetail>(`/api/mail/campaigns/${id}`);
      setDetail(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    }
  };

  const decide = async (approvalId: string, decision: "approve" | "reject") => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/mail/approvals/${approvalId}`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      });
      if (detail) await openDetail(detail.campaign.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Decision failed");
    } finally {
      setBusy(false);
    }
  };

  const send = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ sent: number; suppressed: number; failed: number; spendCents: number; mode: string; renderedOnly: boolean }>(
        `/api/mail/campaigns/${id}/send`,
        { method: "POST" },
      );
      alert(`Sent ${res.sent} (${res.suppressed} suppressed, ${res.failed} failed) — ${res.renderedOnly ? "test mode, rendered only" : "live"}. Spend ${money(res.spendCents)}.`);
      await openDetail(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setBusy(false);
    }
  };

  if (detail) {
    const { campaign, pieces, verification } = detail;
    const latestApproval = campaign.approvals?.[0] ?? null;
    return (
      <div className="space-y-3">
        <button className={btnSecondary} onClick={() => setDetail(null)}><ArrowLeft size={14} /> All campaigns</button>
        <ErrorBox message={error} />
        <div className="rounded-[10px] border border-stone-200 bg-white p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-semibold text-stone-900">{campaign.name}</h2>
            <StatusChip status={campaign.status} />
            <span className="ml-auto text-[12px] text-stone-500">
              {campaign.pieceCount ?? 0} pieces · est {money(campaign.estCostCents)}
              {campaign.actualCostCents != null ? ` · actual ${money(campaign.actualCostCents)}` : ""}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-stone-500">
            <span>Creative: {campaign.creative ? `${campaign.creative.name} (${campaign.creative.size}, ${campaign.creative.status})` : "—"}</span>
            <span>Provider: {campaign.provider ? `${campaign.provider.provider} (${campaign.provider.mode})` : "fake (test)"}</span>
            {campaign.inHomeStart ? <span>In-home: {fmtDate(campaign.inHomeStart)} – {fmtDate(campaign.inHomeEnd ?? null)}</span> : null}
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-[12px]">
            <span className="text-stone-500">Pieces:</span>
            {Object.entries(pieces).map(([s, n]) => (
              <span key={s} className="inline-flex items-center gap-1"><StatusChip status={s} />{n}</span>
            ))}
            <span className="ml-3 text-stone-500">Verification:</span>
            {Object.entries(verification).map(([s, n]) => (
              <span key={s} className="inline-flex items-center gap-1"><VerifyChip status={s} />{n}</span>
            ))}
          </div>
        </div>

        <div className="rounded-[10px] border border-stone-200 bg-white p-4">
          <h3 className="mb-2 text-[13px] font-semibold text-stone-900">Approvals</h3>
          {!latestApproval ? (
            <div className="text-[13px] text-stone-500">No approval requested yet — use the builder or request one from the campaign.</div>
          ) : (
            <div className="space-y-2">
              {campaign.approvals.map((a) => (
                <div key={a.id} className="flex flex-wrap items-center gap-2 rounded-md border border-stone-100 bg-stone-50 p-2.5 text-[13px]">
                  <StatusChip status={a.status} />
                  <span className="text-stone-600">{a.pieceCount} pieces · max {money(a.maxSpendCents)}</span>
                  <span className="font-mono text-[11px] text-stone-400">hash {a.creativeHash?.slice(0, 12) ?? "—"}</span>
                  {a.decidedAt ? <span className="text-[12px] text-stone-400">decided {fmtDate(a.decidedAt)}</span> : null}
                  {a.status === "pending" ? (
                    <span className="ml-auto flex gap-2">
                      <button className={btnPrimary} disabled={busy} onClick={() => decide(a.id, "approve")}>
                        <Check size={14} /> Approve
                      </button>
                      <button className={btnSecondary} disabled={busy} onClick={() => decide(a.id, "reject")}>
                        <X size={14} /> Reject
                      </button>
                    </span>
                  ) : null}
                </div>
              ))}
              {campaign.status === "approved" ? (
                <button className={btnPrimary} disabled={busy} onClick={() => send(campaign.id)}>
                  <Truck size={14} /> Send now
                </button>
              ) : null}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[13px] text-stone-500">
          Standalone mail campaigns — bulk sends with C3 approval binding creative hash, piece count, and max spend.
        </div>
        <button className={btnPrimary} onClick={onNew}><Plus size={14} /> New campaign</button>
      </div>
      <ErrorBox message={error} />
      {campaigns === null && !error ? (
        <div className="flex items-center gap-2 p-6 text-[13px] text-stone-500"><Loader2 size={14} className="animate-spin" /> Loading…</div>
      ) : (campaigns ?? []).length === 0 ? (
        <div className="rounded-[10px] border border-dashed border-stone-300 bg-white p-8 text-center">
          <Mailbox size={22} className="mx-auto text-stone-300" />
          <div className="mt-2 text-[14px] font-medium text-stone-700">No campaigns yet</div>
          <div className="mt-1 text-[13px] text-stone-500">Run the builder wizard to verify an audience, pick creative, and get an estimate.</div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-[10px] border border-stone-200 bg-white">
          <table className="w-full min-w-[680px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                <th className="px-3 py-2 font-medium">Campaign</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Pieces</th>
                <th className="px-3 py-2 font-medium">Est. cost</th>
                <th className="px-3 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {(campaigns ?? []).map((c) => (
                <tr key={c.id} className="cursor-pointer border-b border-stone-100 last:border-0 hover:bg-violet-50/40" onClick={() => openDetail(c.id)}>
                  <td className="px-3 py-2 font-medium text-stone-900">{c.name}</td>
                  <td className="px-3 py-2"><StatusChip status={c.status} /></td>
                  <td className="px-3 py-2 text-stone-600">{c.pieceCount ?? "—"}</td>
                  <td className="px-3 py-2 text-stone-600">{money(c.estCostCents)}</td>
                  <td className="px-3 py-2 text-[12px] text-stone-500">{fmtDate(c.createdAt ?? null)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Nurture mail tab (R3; backed by T1's tables)
// ---------------------------------------------------------------------------

interface NurturePieceRow {
  campaignId: string;
  campaignName: string;
  campaignStatus: string;
  channel: string | null;
  sequenceId: string | null;
  stepIndex: number | null;
  mailDate: string | null;
  inHomeStart: string | null;
  inHomeEnd: string | null;
  pieceId: string;
  leadId: string | null;
  leadName: string | null;
  verificationStatus: string;
  qrSlug: string | null;
  pieceStatus: string;
  providerPieceId: string | null;
  costCents: number | null;
  sentAt: string | null;
  deliveredAt: string | null;
  suppressionReason: string | null;
  approvalStatus: string | null;
  maxSpendCents: number | null;
}

function PiecesTab() {
  const [pieces, setPieces] = useState<NurturePieceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api<{ pieces: NurturePieceRow[] }>("/api/mail-nurture/pieces");
      setPieces(data.pieces ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[13px] text-stone-500">
          Mail pieces queued by nurture sequences — consent, caps, verification, C3 approval, and metering,
          with date-based in-home windows instead of quiet hours. Each piece is one T1 campaign.
        </div>
        <button className={btnSecondary} onClick={load}><RefreshCw size={14} /> Refresh</button>
      </div>
      <ErrorBox message={error} />
      {pieces === null && !error ? (
        <div className="flex items-center gap-2 p-6 text-[13px] text-stone-500"><Loader2 size={14} className="animate-spin" /> Loading…</div>
      ) : (
        <div className="overflow-x-auto rounded-[10px] border border-stone-200 bg-white">
          <table className="w-full min-w-[980px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                <th className="px-3 py-2 font-medium">Lead</th>
                <th className="px-3 py-2 font-medium">Channel</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Verification</th>
                <th className="px-3 py-2 font-medium">QR slug</th>
                <th className="px-3 py-2 font-medium">Mail date</th>
                <th className="px-3 py-2 font-medium">In-home</th>
                <th className="px-3 py-2 font-medium">Provider piece</th>
                <th className="px-3 py-2 font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {(pieces ?? []).map((p) => (
                <tr key={p.pieceId} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                  <td className="px-3 py-2">
                    <div className="font-medium text-stone-900">{p.leadName ?? "—"}</div>
                    <div className="text-[12px] text-stone-500">{p.stepIndex != null ? `step ${p.stepIndex + 1}` : p.campaignName}</div>
                  </td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-px text-[11px] font-medium text-amber-700">
                      {p.channel === "postcard" ? <Mailbox size={11} /> : <FileText size={11} />}{p.channel ?? "—"}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <StatusChip status={p.pieceStatus} />
                    {p.suppressionReason ? <div className="mt-0.5 text-[11px] text-stone-400">{p.suppressionReason}</div> : null}
                    {p.approvalStatus ? <div className="mt-0.5 text-[11px] text-stone-400">approval: {p.approvalStatus}</div> : null}
                  </td>
                  <td className="px-3 py-2"><VerifyChip status={p.verificationStatus} /></td>
                  <td className="px-3 py-2 font-mono text-[12px] text-stone-600">{p.qrSlug ?? "—"}</td>
                  <td className="px-3 py-2 text-[12px] text-stone-600">{fmtDate(p.mailDate)}</td>
                  <td className="px-3 py-2 text-[12px] text-stone-600">
                    {p.inHomeStart && p.inHomeEnd ? `${fmtDate(p.inHomeStart)} – ${fmtDate(p.inHomeEnd)}` : "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-[12px] text-stone-600">{p.providerPieceId ?? "—"}</td>
                  <td className="px-3 py-2 text-stone-600">{money(p.costCents)}</td>
                </tr>
              ))}
              {(pieces ?? []).length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center">
                    <Truck size={22} className="mx-auto text-stone-300" />
                    <div className="mt-2 text-[14px] font-medium text-stone-700">No mail pieces yet</div>
                    <div className="mt-1 text-[13px] text-stone-500">Add a postcard or letter step to a nurture sequence — pieces appear here after the approval gate.</div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Builder wizard (T1 routes)
// ---------------------------------------------------------------------------

const WIZARD_STEPS = ["Audience", "Verify", "Creative", "Estimate", "Approval", "Send"] as const;

interface CostLine { label: string; cents: number; quantity?: number; basis?: string }

interface StudioCreativeOpt {
  id: string;
  name: string;
  size: string;
  status: string;
  formatTrack: string;
}

function parseCsvRows(text: string): Array<{ name?: string; line1: string; city: string; state: string; zip: string }> {
  const rows: Array<{ name?: string; line1: string; city: string; state: string; zip: string }> = [];
  for (const line of text.split("\n")) {
    const parts = line.split("|").map((s) => s.trim());
    if (parts.length < 4) continue;
    const [name, line1, city, state, zip] = parts.length >= 5 ? parts : ["", ...parts];
    if (!line1 || !city || !state || !zip) continue;
    rows.push({ ...(name ? { name } : {}), line1, city, state, zip: zip ?? "" });
  }
  return rows;
}

function BuilderWizard() {
  const [step, setStep] = useState(0);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [audKind, setAudKind] = useState<"csv" | "crm_segment" | "prospect_list">("csv");
  const [audRef, setAudRef] = useState("");
  const [csvText, setCsvText] = useState("");
  const [creativeId, setCreativeId] = useState("");
  const [creatives, setCreatives] = useState<StudioCreativeOpt[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [audienceRes, setAudienceRes] = useState<{ created: number; skippedNoAddress: number; total: number } | null>(null);
  const [verifyRes, setVerifyRes] = useState<{ valid: number; corrected: number; quarantined: number } | null>(null);
  const [estimate, setEstimate] = useState<{
    lineItems: CostLine[];
    subtotalCents: number;
    marginPreviewCents: number;
    totalWithMarginCents: number;
    sendablePieces: number;
    pendingVerifications: number;
  } | null>(null);
  const [approval, setApproval] = useState<{ id: string; status: string; maxSpendCents: number } | null>(null);
  const [sendRes, setSendRes] = useState<{ sent: number; suppressed: number; failed: number; spendCents: number; mode: string; renderedOnly: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ creatives: StudioCreativeOpt[] }>("/api/studio/creatives?channelTemplate=print&formatTrack=addressed")
      .then((d) => setCreatives(d.creatives ?? []))
      .catch(() => setCreatives([]));
  }, []);

  async function run<T>(fn: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      return null;
    } finally {
      setBusy(false);
    }
  }

  const createCampaign = () =>
    run(async () => {
      const data = await api<{ campaign: { id: string } }>("/api/mail/campaigns", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      });
      const id = data.campaign.id;
      const audience =
        audKind === "csv"
          ? { kind: "csv" as const, rows: parseCsvRows(csvText) }
          : { kind: audKind, ref: audRef.trim() || undefined };
      const built = await api<{ created: number; skippedNoAddress: number; total: number }>(
        `/api/mail/campaigns/${id}/audience`,
        { method: "POST", body: JSON.stringify(audience) },
      );
      setCampaignId(id);
      setAudienceRes(built);
      setStep(1);
    });

  const verifyAudience = () =>
    run(async () => {
      const data = await api<{ valid: number; corrected: number; quarantined: number }>(
        `/api/mail/campaigns/${campaignId}/verify`,
        { method: "POST" },
      );
      setVerifyRes(data);
      setStep(2);
    });

  const saveCreative = () =>
    run(async () => {
      if (!creativeId) throw new Error("Pick a Studio creative first");
      await api(`/api/mail/campaigns/${campaignId}`, {
        method: "PATCH",
        body: JSON.stringify({ creativeId }),
      });
      setStep(3);
    });

  const getEstimate = () =>
    run(async () => {
      const data = await api<{
        lineItems: CostLine[];
        subtotalCents: number;
        marginPreviewCents: number;
        totalWithMarginCents: number;
        sendablePieces: number;
        pendingVerifications: number;
      }>(`/api/mail/campaigns/${campaignId}/estimate`);
      setEstimate(data);
      setStep(4);
    });

  const requestApproval = () =>
    run(async () => {
      const data = await api<{ approval: { id: string; status: string; maxSpendCents: number } }>(
        `/api/mail/campaigns/${campaignId}/request-approval`,
        { method: "POST" },
      );
      setApproval(data.approval);
      setStep(5);
    });

  const decide = (decision: "approve" | "reject") =>
    run(async () => {
      const data = await api<{ approval: { id: string; status: string; maxSpendCents: number } }>(
        `/api/mail/approvals/${approval?.id}`,
        { method: "POST", body: JSON.stringify({ decision }) },
      );
      setApproval(data.approval);
    });

  const send = () =>
    run(async () => {
      const data = await api<{
        sent: number; suppressed: number; failed: number; spendCents: number; mode: string; renderedOnly: boolean;
      }>(`/api/mail/campaigns/${campaignId}/send`, { method: "POST" });
      setSendRes(data);
    });

  const audienceValid =
    audKind === "csv" ? parseCsvRows(csvText).length > 0 : audRef.trim().length > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1">
        {WIZARD_STEPS.map((s, i) => (
          <div key={s} className="flex items-center">
            <button
              onClick={() => (campaignId && i <= step ? setStep(i) : null)}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium ${
                i === step
                  ? "border-violet-300 bg-violet-50 text-violet-700"
                  : i < step
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-stone-200 bg-white text-stone-400"
              }`}
            >
              {i < step ? <Check size={12} /> : <span className="text-[11px]">{i + 1}</span>}
              {s}
            </button>
            {i < WIZARD_STEPS.length - 1 ? <ChevronRight size={13} className="mx-0.5 text-stone-300" /> : null}
          </div>
        ))}
      </div>

      <div className="rounded-[10px] border border-stone-200 bg-white p-4">
        <ErrorBox message={error} />

        {step === 0 ? (
          <div className="max-w-[560px] space-y-3">
            <h2 className="text-[15px] font-semibold text-stone-900">Audience</h2>
            <div>
              <label className="mb-1 block text-[12px] font-medium text-stone-600">Campaign name</label>
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Q4 win-back postcard" />
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-medium text-stone-600">Audience source</label>
              <select className={inputCls} value={audKind} onChange={(e) => setAudKind(e.target.value as typeof audKind)}>
                <option value="csv">Paste addresses (CSV)</option>
                <option value="crm_segment">CRM segment</option>
                <option value="prospect_list">Prospect list</option>
              </select>
            </div>
            {audKind === "csv" ? (
              <div>
                <label className="mb-1 block text-[12px] font-medium text-stone-600">
                  Addresses — one per line: Name | Street | City | ST | ZIP
                </label>
                <textarea
                  className={`${inputCls} min-h-[120px] font-mono text-[12px]`}
                  value={csvText}
                  onChange={(e) => setCsvText(e.target.value)}
                  placeholder={"Jane Doe | 123 Main St | Greensboro | NC | 27401"}
                />
                <div className="mt-1 text-[12px] text-stone-500">{parseCsvRows(csvText).length} usable rows</div>
              </div>
            ) : (
              <div>
                <label className="mb-1 block text-[12px] font-medium text-stone-600">
                  {audKind === "crm_segment" ? "Segment filters (JSON)" : "Prospect list ID"}
                </label>
                <input className={inputCls} value={audRef} onChange={(e) => setAudRef(e.target.value)} placeholder={audKind === "crm_segment" ? '{"minScore": 50, "limit": 500}' : "list id"} />
              </div>
            )}
            <button className={btnPrimary} disabled={!name.trim() || !audienceValid || busy} onClick={createCampaign}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />} Create draft + build pieces
            </button>
            {audienceRes ? (
              <div className="text-[13px] text-stone-600">
                Built {audienceRes.created} pieces ({audienceRes.skippedNoAddress} skipped — no address).
              </div>
            ) : null}
          </div>
        ) : null}

        {step === 1 ? (
          <div className="max-w-[520px] space-y-3">
            <h2 className="text-[15px] font-semibold text-stone-900">Verify addresses</h2>
            <p className="text-[13px] text-stone-500">
              Runs pieces through provider address verification (CASS). Unverifiable addresses are
              quarantined — never silently mailed. NCOA-changed addresses come back corrected.
            </p>
            {verifyRes ? (
              <div className="flex flex-wrap gap-2 text-[13px]">
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700"><BadgeCheck size={12} /> {verifyRes.valid} valid</span>
                <span className="inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 font-medium text-sky-700"><BadgeCheck size={12} /> {verifyRes.corrected} corrected</span>
                <span className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2 py-0.5 font-medium text-red-700"><AlertTriangle size={12} /> {verifyRes.quarantined} quarantined</span>
              </div>
            ) : (
              <button className={btnPrimary} disabled={busy} onClick={verifyAudience}>
                {busy ? <Loader2 size={14} className="animate-spin" /> : null} Run verification
              </button>
            )}
            {verifyRes ? <button className={btnPrimary} onClick={() => setStep(2)}>Continue <ArrowRight size={14} /></button> : null}
          </div>
        ) : null}

        {step === 2 ? (
          <div className="max-w-[520px] space-y-3">
            <h2 className="text-[15px] font-semibold text-stone-900">Creative</h2>
            <p className="text-[13px] text-stone-500">
              Pick print-ready creative from the Studio (Track T2). The creative hash is bound to the
              approval — the piece cannot send if the creative changes afterwards.
            </p>
            <div>
              <label className="mb-1 block text-[12px] font-medium text-stone-600">Studio creative</label>
              <select className={inputCls} value={creativeId} onChange={(e) => setCreativeId(e.target.value)}>
                <option value="">Select a creative…</option>
                {(creatives ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} — {c.size} ({c.status})
                  </option>
                ))}
              </select>
              {creatives !== null && creatives.length === 0 ? (
                <div className="mt-1 text-[12px] text-stone-400">No addressed-format creatives in the Studio yet.</div>
              ) : null}
            </div>
            <button className={btnPrimary} disabled={busy || !creativeId} onClick={saveCreative}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : null} Save creative <ArrowRight size={14} />
            </button>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="max-w-[520px] space-y-3">
            <h2 className="text-[15px] font-semibold text-stone-900">Cost estimate</h2>
            <p className="text-[13px] text-stone-500">
              Provider cost for {estimate?.sendablePieces ?? "…"} sendable pieces
              {estimate && estimate.pendingVerifications > 0 ? ` (${estimate.pendingVerifications} still unverified)` : ""}.
            </p>
            {estimate ? (
              <table className="w-full text-left text-[13px]">
                <tbody className="divide-y divide-stone-100">
                  {estimate.lineItems.map((l) => (
                    <tr key={l.label}>
                      <td className="py-1.5 text-stone-700">{l.label}{l.quantity ? <span className="text-stone-400"> × {l.quantity}</span> : null}</td>
                      <td className="py-1.5 text-right font-medium text-stone-900">{money(l.cents)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="py-1.5 text-stone-600">Hosted margin preview</td>
                    <td className="py-1.5 text-right text-stone-600">{money(estimate.marginPreviewCents)}</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 font-semibold text-stone-900">Max spend (approval binds this)</td>
                    <td className="py-1.5 text-right font-semibold text-stone-900">{money(estimate.totalWithMarginCents)}</td>
                  </tr>
                </tbody>
              </table>
            ) : (
              <button className={btnPrimary} disabled={busy} onClick={getEstimate}>
                {busy ? <Loader2 size={14} className="animate-spin" /> : null} Get estimate
              </button>
            )}
            {estimate ? <button className={btnPrimary} onClick={() => setStep(4)}>Continue <ArrowRight size={14} /></button> : null}
          </div>
        ) : null}

        {step === 4 ? (
          <div className="max-w-[520px] space-y-3">
            <h2 className="text-[15px] font-semibold text-stone-900">C3 approval</h2>
            <p className="text-[13px] text-stone-500">
              A human approves the audience, creative hash, exact piece count, and max spend. No live send
              without this — test mode until then.
            </p>
            {approval ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-[13px]">
                  <StatusChip status={approval.status} />
                  <span className="text-stone-600">max {money(approval.maxSpendCents)}</span>
                  <span className="font-mono text-[12px] text-stone-500">{approval.id.slice(-8)}</span>
                </div>
                {approval.status === "pending" ? (
                  <div className="flex gap-2">
                    <button className={btnPrimary} disabled={busy} onClick={() => decide("approve")}>
                      <Check size={14} /> Approve
                    </button>
                    <button className={btnSecondary} disabled={busy} onClick={() => decide("reject")}>
                      <X size={14} /> Reject
                    </button>
                  </div>
                ) : null}
              </div>
            ) : (
              <button className={btnPrimary} disabled={busy} onClick={requestApproval}>
                {busy ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />} Request approval
              </button>
            )}
            {approval?.status === "approved" ? <button className={btnPrimary} onClick={() => setStep(5)}>Continue <ArrowRight size={14} /></button> : null}
          </div>
        ) : null}

        {step === 5 ? (
          <div className="max-w-[520px] space-y-3">
            <h2 className="text-[15px] font-semibold text-stone-900">Send</h2>
            <div className="rounded-md border border-violet-200 bg-violet-50 p-2.5 text-[13px] text-violet-800">
              Test mode — pieces are rendered, never physically mailed. Live sends need a provider row in
              live mode plus an approved campaign.
            </div>
            {sendRes ? (
              <div className="text-[13px] text-stone-700">
                Sent {sendRes.sent} · suppressed {sendRes.suppressed} · failed {sendRes.failed} · spend {money(sendRes.spendCents)}
                {sendRes.renderedOnly ? " (rendered only)" : null}
              </div>
            ) : (
              <button className={btnPrimary} disabled={busy || approval?.status !== "approved"} onClick={send}>
                {busy ? <Loader2 size={14} className="animate-spin" /> : null} Send campaign
              </button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function MailApp() {
  const [tab, setTab] = useState<Tab>("campaigns");
  const TABS = [
    { id: "campaigns" as const, label: "Campaigns", icon: Mailbox },
    { id: "pieces" as const, label: "Nurture mail", icon: Truck },
    { id: "builder" as const, label: "New campaign", icon: Plus },
  ];
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="mb-4 flex gap-1 border-b border-stone-200">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] font-medium transition ${
              tab === id
                ? "border-violet-600 text-violet-700"
                : "border-transparent text-stone-500 hover:text-stone-800"
            }`}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>
      {tab === "campaigns" ? <CampaignsTab onNew={() => setTab("builder")} /> : null}
      {tab === "pieces" ? <PiecesTab /> : null}
      {tab === "builder" ? <BuilderWizard /> : null}
    </div>
  );
}
