"use client";

// Marketr — Direct Mail dashboard: campaign list + detail, nurture mail
// pieces (R3 integration), and the campaign builder wizard.
//
// Consumes Track T1's live routes (app/api/mail/campaigns/**,
// app/api/mail/approvals/[id]) and the R3 nurture ledger
// (/api/mail-nurture/pieces, backed by T1's tables). Studio creative picker
// uses Track T2's /api/studio/creatives.

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
// Agentic OS atoms
// ---------------------------------------------------------------------------
// Visual migration only: same layout, same behavior. Campaign, piece,
// verification, and approval statuses are workflow states, so every chip
// renders neutral — these are never agent states. Approval decisions and
// sends keep their dedicated actions: approve (done), reject (deny),
// request approval (needs review), send (execute — irreversible).

function StatusChip({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-1.5 py-0.5 text-[11px] font-medium leading-tight text-muted shadow-control">
      {status}
    </span>
  );
}

function VerifyChip({ status }: { status: string | null }) {
  if (!status) return <span className="text-[12px] text-subtle">—</span>;
  const ok = status === "valid" || status === "corrected";
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-1.5 py-0.5 text-[11px] font-medium leading-tight text-muted shadow-control">
      {ok ? <BadgeCheck size={11} className="text-ink" /> : <AlertTriangle size={11} className="text-ink" />}
      {status}
    </span>
  );
}

const inputCls =
  "w-full h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none disabled:opacity-50";
const btnPrimary =
  "inline-flex h-control-sm cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:opacity-40";
const btnSecondary =
  "inline-flex h-control-sm cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:opacity-40";
const btnDanger =
  "inline-flex h-control-sm cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-paper px-4 text-sm font-semibold text-failed-text aos-press shadow-[inset_0_0_0_1.5px_var(--aos-failed)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:opacity-40";
const btnApprove =
  "inline-flex h-control-sm cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-done px-4 text-sm font-semibold text-white aos-press focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:opacity-40";
const btnReview =
  "inline-flex h-control-sm cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-needs px-4 text-sm font-semibold text-ink aos-press hover:brightness-95 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:opacity-40";
/** Executes an approved action (irreversible send): running blue. */
const btnExecute =
  "inline-flex h-control-sm cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-running px-4 text-sm font-semibold text-white aos-press hover:brightness-110 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:opacity-40";

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
  return (
    <div className="flex items-start gap-2 rounded-md bg-failed-tint p-2.5 text-[13px] text-failed-text">
      <span className="aos-shape aos-shape--failed mt-0.5 shrink-0" role="img" aria-label="Error" />
      <span>{message}</span>
    </div>
  );
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
        <div className="rounded-lg bg-paper p-4 shadow-hairline">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-semibold text-ink">{campaign.name}</h2>
            <StatusChip status={campaign.status} />
            <span className="ml-auto text-[12px] text-muted">
              {campaign.pieceCount ?? 0} pieces · est {money(campaign.estCostCents)}
              {campaign.actualCostCents != null ? ` · actual ${money(campaign.actualCostCents)}` : ""}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
            <span>Creative: {campaign.creative ? `${campaign.creative.name} (${campaign.creative.size}, ${campaign.creative.status})` : "—"}</span>
            <span>Provider: {campaign.provider ? `${campaign.provider.provider} (${campaign.provider.mode})` : "fake (test)"}</span>
            {campaign.inHomeStart ? <span>In-home: {fmtDate(campaign.inHomeStart)} – {fmtDate(campaign.inHomeEnd ?? null)}</span> : null}
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-[12px]">
            <span className="text-muted">Pieces:</span>
            {Object.entries(pieces).map(([s, n]) => (
              <span key={s} className="inline-flex items-center gap-1"><StatusChip status={s} />{n}</span>
            ))}
            <span className="ml-3 text-muted">Verification:</span>
            {Object.entries(verification).map(([s, n]) => (
              <span key={s} className="inline-flex items-center gap-1"><VerifyChip status={s} />{n}</span>
            ))}
          </div>
        </div>

        <div className="rounded-lg bg-paper p-4 shadow-hairline">
          <h3 className="mb-2 text-[13px] font-semibold text-ink">Approvals</h3>
          {!latestApproval ? (
            <div className="text-[13px] text-muted">No approval requested yet — use the builder or request one from the campaign.</div>
          ) : (
            <div className="space-y-2">
              {campaign.approvals.map((a) => (
                <div key={a.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-canvas p-2.5 text-[13px]">
                  <StatusChip status={a.status} />
                  <span className="text-muted">{a.pieceCount} pieces · max {money(a.maxSpendCents)}</span>
                  <span className="aos-mono text-[11px] text-subtle">hash {a.creativeHash?.slice(0, 12) ?? "—"}</span>
                  {a.decidedAt ? <span className="text-[12px] text-subtle">decided {fmtDate(a.decidedAt)}</span> : null}
                  {a.status === "pending" ? (
                    <span className="ml-auto flex gap-2">
                      <button className={btnApprove} disabled={busy} onClick={() => decide(a.id, "approve")}>
                        <Check size={14} /> Approve
                      </button>
                      <button className={btnDanger} disabled={busy} onClick={() => decide(a.id, "reject")}>
                        <X size={14} /> Reject
                      </button>
                    </span>
                  ) : null}
                </div>
              ))}
              {campaign.status === "approved" ? (
                <button className={btnExecute} disabled={busy} onClick={() => send(campaign.id)}>
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
        <div className="text-[13px] text-muted">
          Standalone mail campaigns — bulk sends with C3 approval binding creative hash, piece count, and max spend.
        </div>
        <button className={btnPrimary} onClick={onNew}><Plus size={14} /> New campaign</button>
      </div>
      <ErrorBox message={error} />
      {campaigns === null && !error ? (
        <div className="flex items-center gap-2 p-6 text-[13px] text-muted"><Loader2 size={14} className="aos-spin" /> Loading…</div>
      ) : (campaigns ?? []).length === 0 ? (
        <div className="rounded-lg border border-dashed border-line bg-paper p-8 text-center">
          <Mailbox size={22} className="mx-auto text-subtle" />
          <div className="mt-2 text-[14px] font-medium text-ink">No campaigns yet</div>
          <div className="mt-1 text-[13px] text-muted">Run the builder wizard to verify an audience, pick creative, and get an estimate.</div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg bg-paper shadow-hairline">
          <table className="w-full min-w-[680px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-xs font-semibold text-muted">
                <th className="px-3 py-2">Campaign</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Pieces</th>
                <th className="px-3 py-2">Est. cost</th>
                <th className="px-3 py-2">Created</th>
              </tr>
            </thead>
            <tbody>
              {(campaigns ?? []).map((c) => (
                <tr key={c.id} className="cursor-pointer border-b border-line last:border-0 hover:bg-hover-paper" onClick={() => openDetail(c.id)}>
                  <td className="px-3 py-2 font-medium text-ink">{c.name}</td>
                  <td className="px-3 py-2"><StatusChip status={c.status} /></td>
                  <td className="px-3 py-2 text-muted">{c.pieceCount ?? "—"}</td>
                  <td className="px-3 py-2 text-muted">{money(c.estCostCents)}</td>
                  <td className="px-3 py-2 text-[12px] text-muted">{fmtDate(c.createdAt ?? null)}</td>
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
        <div className="text-[13px] text-muted">
          Mail pieces queued by nurture sequences — consent, caps, verification, C3 approval, and metering,
          with date-based in-home windows instead of quiet hours. Each piece is one T1 campaign.
        </div>
        <button className={btnSecondary} onClick={load}><RefreshCw size={14} /> Refresh</button>
      </div>
      <ErrorBox message={error} />
      {pieces === null && !error ? (
        <div className="flex items-center gap-2 p-6 text-[13px] text-muted"><Loader2 size={14} className="aos-spin" /> Loading…</div>
      ) : (
        <div className="overflow-x-auto rounded-lg bg-paper shadow-hairline">
          <table className="w-full min-w-[980px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-xs font-semibold text-muted">
                <th className="px-3 py-2">Lead</th>
                <th className="px-3 py-2">Channel</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Verification</th>
                <th className="px-3 py-2">QR slug</th>
                <th className="px-3 py-2">Mail date</th>
                <th className="px-3 py-2">In-home</th>
                <th className="px-3 py-2">Provider piece</th>
                <th className="px-3 py-2">Cost</th>
              </tr>
            </thead>
            <tbody>
              {(pieces ?? []).map((p) => (
                <tr key={p.pieceId} className="border-b border-line last:border-0 hover:bg-hover-paper">
                  <td className="px-3 py-2">
                    <div className="font-medium text-ink">{p.leadName ?? "—"}</div>
                    <div className="text-[12px] text-muted">{p.stepIndex != null ? `step ${p.stepIndex + 1}` : p.campaignName}</div>
                  </td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-1.5 py-px text-[11px] font-medium text-muted shadow-control">
                      {p.channel === "postcard" ? <Mailbox size={11} /> : <FileText size={11} />}{p.channel ?? "—"}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <StatusChip status={p.pieceStatus} />
                    {p.suppressionReason ? <div className="mt-0.5 text-[11px] text-subtle">{p.suppressionReason}</div> : null}
                    {p.approvalStatus ? <div className="mt-0.5 text-[11px] text-subtle">approval: {p.approvalStatus}</div> : null}
                  </td>
                  <td className="px-3 py-2"><VerifyChip status={p.verificationStatus} /></td>
                  <td className="px-3 py-2 aos-mono text-[12px] text-muted">{p.qrSlug ?? "—"}</td>
                  <td className="px-3 py-2 text-[12px] text-muted">{fmtDate(p.mailDate)}</td>
                  <td className="px-3 py-2 text-[12px] text-muted">
                    {p.inHomeStart && p.inHomeEnd ? `${fmtDate(p.inHomeStart)} – ${fmtDate(p.inHomeEnd)}` : "—"}
                  </td>
                  <td className="px-3 py-2 aos-mono text-[12px] text-muted">{p.providerPieceId ?? "—"}</td>
                  <td className="px-3 py-2 text-muted">{money(p.costCents)}</td>
                </tr>
              ))}
              {(pieces ?? []).length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center">
                    <Truck size={22} className="mx-auto text-subtle" />
                    <div className="mt-2 text-[14px] font-medium text-ink">No mail pieces yet</div>
                    <div className="mt-1 text-[13px] text-muted">Add a postcard or letter step to a nurture sequence — pieces appear here after the approval gate.</div>
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
                  ? "border-ink bg-ink text-white"
                  : i < step
                    ? "border-line bg-paper text-ink"
                    : "border-line bg-paper text-subtle"
              }`}
            >
              {i < step ? <Check size={12} className="text-ink" /> : <span className="text-[11px]">{i + 1}</span>}
              {s}
            </button>
            {i < WIZARD_STEPS.length - 1 ? <ChevronRight size={13} className="mx-0.5 text-subtle" /> : null}
          </div>
        ))}
      </div>

      <div className="rounded-lg bg-paper p-4 shadow-hairline">
        <ErrorBox message={error} />

        {step === 0 ? (
          <div className="max-w-[560px] space-y-3">
            <h2 className="text-[15px] font-semibold text-ink">Audience</h2>
            <div>
              <label className="mb-1 block text-xs font-semibold text-muted">Campaign name</label>
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Q4 win-back postcard" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-muted">Audience source</label>
              <select className={inputCls} value={audKind} onChange={(e) => setAudKind(e.target.value as typeof audKind)}>
                <option value="csv">Paste addresses (CSV)</option>
                <option value="crm_segment">CRM segment</option>
                <option value="prospect_list">Prospect list</option>
              </select>
            </div>
            {audKind === "csv" ? (
              <div>
                <label className="mb-1 block text-xs font-semibold text-muted">
                  Addresses — one per line: Name | Street | City | ST | ZIP
                </label>
                <textarea
                  className={`${inputCls} min-h-[120px] aos-mono text-[12px]`}
                  value={csvText}
                  onChange={(e) => setCsvText(e.target.value)}
                  placeholder={"Jane Doe | 123 Main St | Greensboro | NC | 27401"}
                />
                <div className="mt-1 text-[12px] text-muted">{parseCsvRows(csvText).length} usable rows</div>
              </div>
            ) : (
              <div>
                <label className="mb-1 block text-xs font-semibold text-muted">
                  {audKind === "crm_segment" ? "Segment filters (JSON)" : "Prospect list ID"}
                </label>
                <input className={inputCls} value={audRef} onChange={(e) => setAudRef(e.target.value)} placeholder={audKind === "crm_segment" ? '{"minScore": 50, "limit": 500}' : "list id"} />
              </div>
            )}
            <button className={btnPrimary} disabled={!name.trim() || !audienceValid || busy} onClick={createCampaign}>
              {busy ? <Loader2 size={14} className="aos-spin" /> : <ArrowRight size={14} />} Create draft + build pieces
            </button>
            {audienceRes ? (
              <div className="text-[13px] text-muted">
                Built {audienceRes.created} pieces ({audienceRes.skippedNoAddress} skipped — no address).
              </div>
            ) : null}
          </div>
        ) : null}

        {step === 1 ? (
          <div className="max-w-[520px] space-y-3">
            <h2 className="text-[15px] font-semibold text-ink">Verify addresses</h2>
            <p className="text-[13px] text-muted">
              Runs pieces through provider address verification (CASS). Unverifiable addresses are
              quarantined — never silently mailed. NCOA-changed addresses come back corrected.
            </p>
            {verifyRes ? (
              <div className="flex flex-wrap gap-2 text-[13px]">
                <span className="inline-flex items-center gap-1 rounded-full bg-paper px-2 py-0.5 font-medium text-muted shadow-control"><BadgeCheck size={12} className="text-ink" /> {verifyRes.valid} valid</span>
                <span className="inline-flex items-center gap-1 rounded-full bg-paper px-2 py-0.5 font-medium text-muted shadow-control"><BadgeCheck size={12} className="text-ink" /> {verifyRes.corrected} corrected</span>
                <span className="inline-flex items-center gap-1 rounded-full bg-paper px-2 py-0.5 font-medium text-muted shadow-control"><AlertTriangle size={12} className="text-ink" /> {verifyRes.quarantined} quarantined</span>
              </div>
            ) : (
              <button className={btnPrimary} disabled={busy} onClick={verifyAudience}>
                {busy ? <Loader2 size={14} className="aos-spin" /> : null} Run verification
              </button>
            )}
            {verifyRes ? <button className={btnPrimary} onClick={() => setStep(2)}>Continue <ArrowRight size={14} /></button> : null}
          </div>
        ) : null}

        {step === 2 ? (
          <div className="max-w-[520px] space-y-3">
            <h2 className="text-[15px] font-semibold text-ink">Creative</h2>
            <p className="text-[13px] text-muted">
              Pick print-ready creative from the Studio (Track T2). The creative hash is bound to the
              approval — the piece cannot send if the creative changes afterwards.
            </p>
            <div>
              <label className="mb-1 block text-xs font-semibold text-muted">Studio creative</label>
              <select className={inputCls} value={creativeId} onChange={(e) => setCreativeId(e.target.value)}>
                <option value="">Select a creative…</option>
                {(creatives ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} — {c.size} ({c.status})
                  </option>
                ))}
              </select>
              {creatives !== null && creatives.length === 0 ? (
                <div className="mt-1 text-[12px] text-subtle">No addressed-format creatives in the Studio yet.</div>
              ) : null}
            </div>
            <button className={btnPrimary} disabled={busy || !creativeId} onClick={saveCreative}>
              {busy ? <Loader2 size={14} className="aos-spin" /> : null} Save creative <ArrowRight size={14} />
            </button>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="max-w-[520px] space-y-3">
            <h2 className="text-[15px] font-semibold text-ink">Cost estimate</h2>
            <p className="text-[13px] text-muted">
              Provider cost for {estimate?.sendablePieces ?? "…"} sendable pieces
              {estimate && estimate.pendingVerifications > 0 ? ` (${estimate.pendingVerifications} still unverified)` : ""}.
            </p>
            {estimate ? (
              <table className="w-full text-left text-[13px]">
                <tbody>
                  {estimate.lineItems.map((l) => (
                    <tr key={l.label}>
                      <td className="py-1.5 text-ink">{l.label}{l.quantity ? <span className="text-subtle"> × {l.quantity}</span> : null}</td>
                      <td className="py-1.5 text-right font-medium text-ink">{money(l.cents)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="py-1.5 text-muted">Hosted margin preview</td>
                    <td className="py-1.5 text-right text-muted">{money(estimate.marginPreviewCents)}</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 font-semibold text-ink">Max spend (approval binds this)</td>
                    <td className="py-1.5 text-right font-semibold text-ink">{money(estimate.totalWithMarginCents)}</td>
                  </tr>
                </tbody>
              </table>
            ) : (
              <button className={btnPrimary} disabled={busy} onClick={getEstimate}>
                {busy ? <Loader2 size={14} className="aos-spin" /> : null} Get estimate
              </button>
            )}
            {estimate ? <button className={btnPrimary} onClick={() => setStep(4)}>Continue <ArrowRight size={14} /></button> : null}
          </div>
        ) : null}

        {step === 4 ? (
          <div className="max-w-[520px] space-y-3">
            <h2 className="text-[15px] font-semibold text-ink">C3 approval</h2>
            <p className="text-[13px] text-muted">
              A human approves the audience, creative hash, exact piece count, and max spend. No live send
              without this — test mode until then.
            </p>
            {approval ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-[13px]">
                  <StatusChip status={approval.status} />
                  <span className="text-muted">max {money(approval.maxSpendCents)}</span>
                  <span className="aos-mono text-[12px] text-muted">{approval.id.slice(-8)}</span>
                </div>
                {approval.status === "pending" ? (
                  <div className="flex gap-2">
                    <button className={btnApprove} disabled={busy} onClick={() => decide("approve")}>
                      <Check size={14} /> Approve
                    </button>
                    <button className={btnDanger} disabled={busy} onClick={() => decide("reject")}>
                      <X size={14} /> Reject
                    </button>
                  </div>
                ) : null}
              </div>
            ) : (
              <button className={btnReview} disabled={busy} onClick={requestApproval}>
                {busy ? <Loader2 size={14} className="aos-spin" /> : <ShieldCheck size={14} />} Request approval
              </button>
            )}
            {approval?.status === "approved" ? <button className={btnPrimary} onClick={() => setStep(5)}>Continue <ArrowRight size={14} /></button> : null}
          </div>
        ) : null}

        {step === 5 ? (
          <div className="max-w-[520px] space-y-3">
            <h2 className="text-[15px] font-semibold text-ink">Send</h2>
            <div className="rounded-md bg-canvas p-2.5 text-[13px] text-muted">
              Test mode — pieces are rendered, never physically mailed. Live sends need a provider row in
              live mode plus an approved campaign.
            </div>
            {sendRes ? (
              <div className="text-[13px] text-ink">
                Sent {sendRes.sent} · suppressed {sendRes.suppressed} · failed {sendRes.failed} · spend {money(sendRes.spendCents)}
                {sendRes.renderedOnly ? " (rendered only)" : null}
              </div>
            ) : (
              <button className={btnExecute} disabled={busy || approval?.status !== "approved"} onClick={send}>
                {busy ? <Loader2 size={14} className="aos-spin" /> : null} Send campaign
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
      <div className="mb-4 flex gap-1 border-b border-line">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] font-medium transition ${
              tab === id
                ? "border-ink text-ink"
                : "border-transparent text-muted hover:text-ink"
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
