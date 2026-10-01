// Marketr — Wave 2 ChatGPT Ads slice 4: report panel (client).
//
// Summary cards (spend, CTR, CPA), daily table, variance flag, and the
// pull-report button. Agent-readable numbers, human-verifiable rows.

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertTriangle, Download, Loader2 } from "lucide-react";
import type { ReportSummary } from "@/lib/adplatforms/chatgpt/reporting";

const btnGhost =
  "flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-700 hover:bg-stone-50 disabled:opacity-40";

function fmtMoney(cents: number | null | undefined) {
  if (cents == null) return "—";
  return `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-stone-500">{label}</p>
      <p className="text-lg font-semibold text-stone-900">{value}</p>
    </div>
  );
}

export default function ReportPanel({
  campaignId,
  summary,
  variance,
}: {
  campaignId: string;
  summary: ReportSummary;
  variance: { flagged: boolean; driftRatio: number | null; recentCpaCents: number | null; priorCpaCents: number | null; reason: string | null };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = summary.totals;

  async function pull() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/ads/chatgpt/campaigns/${campaignId}/pull-report`, { method: "POST" });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Could not pull the report");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not pull the report");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-medium text-stone-800">Performance — last 14 days</p>
        <button type="button" className={btnGhost} disabled={busy} onClick={pull}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          Pull latest report
        </button>
      </div>

      {variance.flagged && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          CPA drifted {variance.driftRatio != null ? `${Math.abs(variance.driftRatio * 100).toFixed(0)}%` : ""} —
          7-day CPA {fmtMoney(variance.recentCpaCents)} vs prior {fmtMoney(variance.priorCpaCents)}.
          A review task was raised in the alerts hub.
        </p>
      )}
      {!variance.flagged && variance.reason && (
        <p className="text-[12px] text-stone-500">{variance.reason}.</p>
      )}

      <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
        <Stat label="Spend" value={fmtMoney(t.spendCents)} />
        <Stat label="Impressions" value={t.impressions.toLocaleString()} />
        <Stat label="Clicks" value={t.clicks.toLocaleString()} />
        <Stat label="CTR" value={t.ctr != null ? `${(t.ctr * 100).toFixed(2)}%` : "—"} />
        <Stat label="Conversions" value={t.conversions.toLocaleString()} />
        <Stat label="CPA" value={fmtMoney(t.cpaCents)} />
      </div>

      {summary.days.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-stone-200">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50 text-[11px] uppercase tracking-wide text-stone-500">
                <th className="px-3 py-2 font-medium">Day</th>
                <th className="px-3 py-2 font-medium">Spend</th>
                <th className="px-3 py-2 font-medium">Impr.</th>
                <th className="px-3 py-2 font-medium">Clicks</th>
                <th className="px-3 py-2 font-medium">CTR</th>
                <th className="px-3 py-2 font-medium">Conv.</th>
                <th className="px-3 py-2 font-medium">CPA</th>
              </tr>
            </thead>
            <tbody>
              {summary.days.map((d) => (
                <tr key={d.date} className="border-b border-stone-100 last:border-0 hover:bg-[var(--brand-50)]/40">
                  <td className="px-3 py-2 text-stone-600">{d.date}</td>
                  <td className="px-3 py-2 text-stone-900">{fmtMoney(d.spendCents)}</td>
                  <td className="px-3 py-2 text-stone-600">{d.impressions.toLocaleString()}</td>
                  <td className="px-3 py-2 text-stone-600">{d.clicks.toLocaleString()}</td>
                  <td className="px-3 py-2 text-stone-600">{d.ctr != null ? `${(d.ctr * 100).toFixed(2)}%` : "—"}</td>
                  <td className="px-3 py-2 text-stone-600">{d.conversions.toLocaleString()}</td>
                  <td className="px-3 py-2 text-stone-900">{fmtMoney(d.cpaCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-[13px] text-stone-500">No report rows yet — pull the latest report to fetch delivery from StackAdapt.</p>
      )}

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</p>
      )}
    </div>
  );
}
