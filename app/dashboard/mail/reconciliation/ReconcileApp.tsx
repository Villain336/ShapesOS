// Marketr — reconciliation report client: scope picker, estimate-vs-actual
// table, variance flags, manual invoice entry. Agentic OS design system.
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  FilePlus2,
  Info,
  Plus,
  Receipt,
  RefreshCw,
  X,
} from "lucide-react";
import { closeOnEscape } from "@/lib/ui/keyboard";

interface LineItem {
  label: string;
  estimatedCents: number;
  actualCents: number;
  varianceCents: number;
  source: "ledger" | "webhook" | "invoice";
}

interface Flag {
  code: string;
  severity: "warn" | "info";
  message: string;
}

interface Report {
  scope: { type: string; campaignId?: string; campaignName?: string; month?: string };
  estimated: { campaignEstimateCents: number; pieceCostCents: number; eddmCents: number; totalCents: number };
  actual: { webhookCents: number; invoiceCents: number; totalCents: number };
  varianceCents: number;
  lineItems: LineItem[];
  flags: Flag[];
  generatedAt: string;
}

interface Campaign {
  id: string;
  name: string;
  status: string;
  pieceCount: number;
  estCostCents: number;
  createdAt: string;
  mailedAt: string | null;
}

interface Invoice {
  id: string;
  eventId: string;
  vendor: string;
  invoiceNo: string | null;
  date: string | null;
  scope: { type: string; campaignId?: string; month?: string };
  totalCents: number;
  lines: Array<{ label: string; cents: number }>;
  notes: string | null;
  createdAt: string;
}

async function api<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...opts,
    headers: { "content-type": "application/json", ...(opts?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const signed = (cents: number) => `${cents >= 0 ? "+" : "−"}${money(Math.abs(cents))}`;

const inputCls =
  "w-full h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none disabled:opacity-50";
const btnPrimary =
  "inline-flex h-control-sm cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:opacity-40";
const btnSecondary =
  "inline-flex h-control-sm cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:opacity-40";

type Tone = "violet" | "green" | "amber" | "red" | "blue" | "stone";

// Source tags are workflow states, not agent states: always neutral chips.
// The `tone` prop stays for call-site compatibility.
function Chip({ tone, children }: { tone?: Tone; children: React.ReactNode }) {
  void tone;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-paper px-1.5 py-px text-[11px] font-medium leading-4 text-muted shadow-control">
      {children}
    </span>
  );
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function ReconcileApp() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [mode, setMode] = useState<"campaign" | "month">("campaign");
  const [campaignId, setCampaignId] = useState("");
  const [month, setMonth] = useState(currentMonth());
  const [report, setReport] = useState<Report | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showInvoice, setShowInvoice] = useState(false);

  useEffect(() => {
    api<{ campaigns: Campaign[] }>("/api/mail/reconcile/campaigns")
      .then((d) => {
        setCampaigns(d.campaigns);
        if (d.campaigns.length > 0) setCampaignId(d.campaigns[0].id);
      })
      .catch((e) => setError(e.message));
  }, []);

  const scopeQuery = mode === "campaign" ? `campaignId=${encodeURIComponent(campaignId)}` : `month=${encodeURIComponent(month)}`;

  const run = useCallback(async () => {
    if (mode === "campaign" && !campaignId) return;
    setLoading(true);
    setError(null);
    try {
      const [rep, inv] = await Promise.all([
        api<{ report: Report }>(`/api/mail/reconcile?${scopeQuery}`),
        api<{ invoices: Invoice[] }>(`/api/mail/reconcile/invoices?${scopeQuery}`),
      ]);
      setReport(rep.report);
      setInvoices(inv.invoices);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Report failed");
    } finally {
      setLoading(false);
    }
  }, [scopeQuery, mode, campaignId]);

  useEffect(() => {
    if (!(mode === "month" || (mode === "campaign" && campaignId))) return;
    let cancelled = false;
    (async () => {
      try {
        const [rep, inv] = await Promise.all([
          api<{ report: Report }>(`/api/mail/reconcile?${scopeQuery}`),
          api<{ invoices: Invoice[] }>(`/api/mail/reconcile/invoices?${scopeQuery}`),
        ]);
        if (cancelled) return;
        setReport(rep.report);
        setInvoices(inv.invoices);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Report failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, scopeQuery, campaignId]);

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <div className="flex items-start gap-2 rounded-md bg-failed-tint px-2.5 py-2 text-[12px] text-failed-text">
          <span className="aos-shape aos-shape--failed mt-0.5 shrink-0" role="img" aria-label="Error" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-3 rounded-lg bg-paper px-4 py-3 shadow-hairline">
        <div className="flex gap-3 pt-1.5">
          {(["campaign", "month"] as const).map((m) => (
            <label key={m} className="flex items-center gap-1.5 text-[13px] text-ink">
              <input type="radio" checked={mode === m} onChange={() => setMode(m)} />
              {m === "campaign" ? "Campaign" : "Month"}
            </label>
          ))}
        </div>
        {mode === "campaign" ? (
          <label className="block min-w-[240px]">
            <span className="mb-1 block text-xs font-semibold text-muted">Mail campaign</span>
            <select className={inputCls} value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.status}, {c.pieceCount} pcs)
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-muted">Month</span>
            <input type="month" className={inputCls} value={month} onChange={(e) => setMonth(e.target.value)} />
          </label>
        )}
        <button className={btnPrimary} disabled={loading} onClick={run}>
          <RefreshCw size={14} /> {loading ? "Running…" : "Run reconciliation"}
        </button>
        <button className={btnSecondary} onClick={() => setShowInvoice(true)}>
          <FilePlus2 size={14} /> Import invoice
        </button>
      </div>

      {report ? (
        <>
          <div className="grid gap-3 md:grid-cols-4">
            <SummaryCard label="Estimated (ledger)" value={money(report.estimated.totalCents)} tone="text-ink" />
            <SummaryCard label="Actual (provider)" value={money(report.actual.totalCents)} tone="text-ink" />
            <SummaryCard
              label="Variance"
              value={signed(report.varianceCents)}
              tone={Math.abs(report.varianceCents) > 100 ? "text-ink" : "text-muted"}
            />
            <SummaryCard
              label="Flags"
              value={String(report.flags.length)}
              tone={report.flags.some((f) => f.severity === "warn") ? "text-ink" : "text-muted"}
            />
          </div>

          {report.flags.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              {report.flags.map((f, i) => (
                <div
                  key={i}
                  className={`flex items-start gap-2 rounded-md px-2.5 py-2 text-[12px] ${
                    f.severity === "warn" ? "bg-needs-tint text-ink" : "bg-canvas text-muted"
                  }`}
                >
                  {f.severity === "warn" ? <span className="aos-shape aos-shape--needs aos-shape--edged mt-0.5 shrink-0" role="img" aria-label="Warning" /> : <Info size={14} className="mt-0.5 shrink-0 text-ink" />}
                  <span>{f.message}</span>
                </div>
              ))}
            </div>
          ) : null}

          <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
            <div className="border-b border-line px-4 py-2.5">
              <h3 className="text-[13px] font-semibold text-ink">Line items</h3>
            </div>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-xs font-semibold text-muted">
                  <th className="px-3 py-2">Line</th>
                  <th className="px-3 py-2">Source</th>
                  <th className="px-3 py-2 text-right">Estimated</th>
                  <th className="px-3 py-2 text-right">Actual</th>
                  <th className="px-3 py-2 text-right">Variance</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {report.lineItems.map((l, i) => (
                  <tr key={i} className="border-b border-line last:border-0">
                    <td className="px-3 py-2 text-ink">{l.label}</td>
                    <td className="px-3 py-2">
                      <Chip>{l.source}</Chip>
                    </td>
                    <td className="px-3 py-2 text-right text-muted">{money(l.estimatedCents)}</td>
                    <td className="px-3 py-2 text-right text-muted">{money(l.actualCents)}</td>
                    <td className={`px-3 py-2 text-right font-medium ${Math.abs(l.varianceCents) > 100 ? "text-ink" : "text-muted"}`}>
                      {signed(l.varianceCents)}
                    </td>
                  </tr>
                ))}
                <tr className="bg-canvas font-semibold">
                  <td className="px-3 py-2 text-ink">Total</td>
                  <td className="px-3 py-2" />
                  <td className="px-3 py-2 text-right text-ink">{money(report.estimated.totalCents)}</td>
                  <td className="px-3 py-2 text-right text-ink">{money(report.actual.totalCents)}</td>
                  <td className="px-3 py-2 text-right text-ink">{signed(report.varianceCents)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="rounded-lg bg-paper shadow-hairline">
            <div className="flex items-center gap-1.5 border-b border-line px-4 py-2.5">
              <Receipt size={14} className="text-ink" />
              <h3 className="text-[13px] font-semibold text-ink">Imported invoices ({invoices.length})</h3>
            </div>
            {invoices.length === 0 ? (
              <p className="px-4 py-3 text-[12px] text-subtle">No invoices imported for this scope yet.</p>
            ) : (
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-line text-left text-xs font-semibold text-muted">
                    <th className="px-3 py-2">Vendor</th>
                    <th className="px-3 py-2 font-medium">Invoice #</th>
                    <th className="px-3 py-2 font-medium">Date</th>
                    <th className="px-3 py-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {invoices.map((inv) => (
                    <tr key={inv.id} className="border-b border-line last:border-0">
                      <td className="px-3 py-2 text-ink">{inv.vendor}</td>
                      <td className="px-3 py-2 text-muted">{inv.invoiceNo ?? "—"}</td>
                      <td className="px-3 py-2 text-muted">{inv.date ?? "—"}</td>
                      <td className="px-3 py-2 text-right font-medium text-ink">{money(inv.totalCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : (
        <div className="rounded-lg border border-dashed border-line bg-paper px-4 py-10 text-center">
          <p className="text-[13px] font-medium text-ink">Pick a scope and run reconciliation</p>
          <p className="mt-1 text-[12px] text-subtle">
            Ledger estimates are compared against webhook-derived provider actuals and imported invoices.
          </p>
        </div>
      )}

      {showInvoice ? (
        <InvoiceModal
          mode={mode}
          campaignId={campaignId}
          campaigns={campaigns}
          month={month}
          onClose={() => setShowInvoice(false)}
          onImported={async () => {
            setShowInvoice(false);
            await run();
          }}
        />
      ) : null}
    </div>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="rounded-lg bg-paper px-4 py-3 shadow-hairline">
      <p className="text-xs font-semibold text-muted">{label}</p>
      <p className={`mt-1 text-[20px] font-semibold tabular-nums ${tone}`}>{value}</p>
    </div>
  );
}

function InvoiceModal({
  mode,
  campaignId,
  campaigns,
  month,
  onClose,
  onImported,
}: {
  mode: "campaign" | "month";
  campaignId: string;
  campaigns: Campaign[];
  month: string;
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const [vendor, setVendor] = useState("");
  const [invoiceNo, setInvoiceNo] = useState("");
  const [date, setDate] = useState("");
  const [total, setTotal] = useState("");
  const [scopeCampaignId, setScopeCampaignId] = useState(campaignId);
  const [scopeMonth, setScopeMonth] = useState(month);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const totalCents = Math.round(Number(total) * 100);
      if (!vendor.trim()) throw new Error("Vendor is required.");
      if (!Number.isFinite(totalCents) || totalCents < 0) throw new Error("Enter a valid invoice total.");
      await api("/api/mail/reconcile/invoices", {
        method: "POST",
        body: JSON.stringify({
          vendor: vendor.trim(),
          invoiceNo: invoiceNo.trim() || undefined,
          date: date || undefined,
          scopeType: mode,
          campaignId: mode === "campaign" ? scopeCampaignId : undefined,
          month: mode === "month" ? scopeMonth : undefined,
          totalCents,
          notes: notes.trim() || undefined,
        }),
      });
      await onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/30 p-4 pt-[8vh]" role="presentation" onClick={onClose} onKeyDown={closeOnEscape(onClose)}>
      <div className="w-full max-w-xl rounded-lg border border-line bg-paper shadow-overlay" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <h3 className="text-[14px] font-semibold text-ink">Import provider invoice</h3>
          <button onClick={onClose} className="rounded-full p-1 text-subtle hover:bg-hover-paper hover:text-ink" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="flex flex-col gap-3 p-4">
          {error ? (
            <div className="flex items-start gap-2 rounded-md bg-failed-tint px-2.5 py-2 text-[12px] text-failed-text">
              <span className="aos-shape aos-shape--failed mt-0.5 shrink-0" role="img" aria-label="Error" />
              <span>{error}</span>
            </div>
          ) : null}
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-muted">Vendor</span>
              <input className={inputCls} placeholder="e.g. Lob, PostGrid, Print shop" value={vendor} onChange={(e) => setVendor(e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-muted">Invoice #</span>
              <input className={inputCls} value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-muted">Invoice total ($)</span>
              <input className={inputCls} type="number" min={0} step={0.01} placeholder="0.00" value={total} onChange={(e) => setTotal(e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-muted">Date</span>
              <input className={inputCls} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
          </div>
          {mode === "campaign" ? (
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-muted">Applies to campaign</span>
              <select className={inputCls} value={scopeCampaignId} onChange={(e) => setScopeCampaignId(e.target.value)}>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-muted">Applies to month</span>
              <input type="month" className={inputCls} value={scopeMonth} onChange={(e) => setScopeMonth(e.target.value)} />
            </label>
          )}
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-muted">Notes (optional)</span>
            <input className={inputCls} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
          <div className="flex justify-end gap-2">
            <button className={btnSecondary} onClick={onClose}>
              Cancel
            </button>
            <button className={btnPrimary} disabled={saving} onClick={save}>
              <Plus size={14} /> {saving ? "Importing…" : "Import invoice"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
