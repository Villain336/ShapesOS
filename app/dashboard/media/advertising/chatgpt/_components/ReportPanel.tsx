// Marketr — Wave 2 ChatGPT Ads slice 4: report panel (client).
//
// Summary cards (spend, CTR, CPA), daily table, variance flag, and the
// pull-report button. Agent-readable numbers, human-verifiable rows.

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import type { ReportSummary } from "@/lib/adplatforms/chatgpt/reporting";

const btnSecondarySm =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";

function fmtMoney(cents: number | null | undefined) {
  if (cents == null) return "—";
  return `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-paper px-3 py-2 shadow-hairline">
      <p className="text-xs font-semibold text-muted">{label}</p>
      <p className="text-lg font-bold text-ink">{value}</p>
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
        <p className="text-sm font-semibold text-ink">Performance — last 14 days</p>
        <button type="button" className={btnSecondarySm} disabled={busy} onClick={pull}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          Pull latest report
        </button>
      </div>

      {variance.flagged && (
        <p className="flex items-start gap-2 rounded-lg bg-needs px-3 py-2 text-sm font-medium text-ink">
          <span
            className="aos-shape aos-shape--needs mt-1 shrink-0"
            style={{ color: "var(--aos-ink)" }}
            role="img"
            aria-label="Needs review"
          />
          <span>
            CPA drifted {variance.driftRatio != null ? `${Math.abs(variance.driftRatio * 100).toFixed(0)}%` : ""} —
            7-day CPA {fmtMoney(variance.recentCpaCents)} vs prior {fmtMoney(variance.priorCpaCents)}.
            A review task was raised in the alerts hub.
          </span>
        </p>
      )}
      {!variance.flagged && variance.reason && (
        <p className="text-xs text-subtle">{variance.reason}.</p>
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
        <div className="overflow-x-auto rounded-lg bg-paper shadow-hairline">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line bg-canvas">
                <th className="px-3 py-2 text-xs font-semibold text-muted">Day</th>
                <th className="px-3 py-2 text-xs font-semibold text-muted">Spend</th>
                <th className="px-3 py-2 text-xs font-semibold text-muted">Impr.</th>
                <th className="px-3 py-2 text-xs font-semibold text-muted">Clicks</th>
                <th className="px-3 py-2 text-xs font-semibold text-muted">CTR</th>
                <th className="px-3 py-2 text-xs font-semibold text-muted">Conv.</th>
                <th className="px-3 py-2 text-xs font-semibold text-muted">CPA</th>
              </tr>
            </thead>
            <tbody>
              {summary.days.map((d) => (
                <tr key={d.date} className="border-b border-line last:border-0 hover:bg-hover-paper">
                  <td className="px-3 py-2 text-muted">{d.date}</td>
                  <td className="px-3 py-2 font-semibold text-ink">{fmtMoney(d.spendCents)}</td>
                  <td className="px-3 py-2 text-muted">{d.impressions.toLocaleString()}</td>
                  <td className="px-3 py-2 text-muted">{d.clicks.toLocaleString()}</td>
                  <td className="px-3 py-2 text-muted">{d.ctr != null ? `${(d.ctr * 100).toFixed(2)}%` : "—"}</td>
                  <td className="px-3 py-2 text-muted">{d.conversions.toLocaleString()}</td>
                  <td className="px-3 py-2 font-semibold text-ink">{fmtMoney(d.cpaCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-muted">No report rows yet — pull the latest report to fetch delivery from StackAdapt.</p>
      )}

      {error && (
        <p className="rounded-lg border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text">{error}</p>
      )}
    </div>
  );
}
