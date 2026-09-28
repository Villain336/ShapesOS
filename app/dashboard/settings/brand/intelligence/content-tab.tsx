// Marketr — Brand Intelligence → Content tab (Phase 13B, worker 5).
// Content memory: everything ever made for this company — title, kind,
// channel, angle, when, and performance once analytics feeds it back.
// Read-mostly history surface (records are written by agents + the
// content API, not hand-edited here).

"use client";

import { useMemo, useState } from "react";
import { FileText, Search } from "lucide-react";
import {
  Chip,
  tableShell,
  theadCls,
  thCls,
  rowCls,
  infoNoteCls,
  inputCls,
} from "../../../substrate/ui";

export interface ContentRecordView {
  id: string;
  kind: string;
  title: string;
  angle: string | null;
  channel: string | null;
  performance: Record<string, unknown> | null;
  createdAt: string;
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function perfSummary(perf: Record<string, unknown> | null): string | null {
  if (!perf) return null;
  const parts: string[] = [];
  const num = (k: string) => {
    const v = perf[k];
    return typeof v === "number" ? v.toLocaleString() : null;
  };
  const imp = num("impressions");
  const clicks = num("clicks");
  const conv = num("conversions");
  if (imp) parts.push(`${imp} impr.`);
  if (clicks) parts.push(`${clicks} clicks`);
  if (conv) parts.push(`${conv} conv.`);
  const rank = perf.rankDelta;
  if (typeof rank === "number" && rank !== 0) parts.push(`rank ${rank > 0 ? "+" : ""}${rank}`);
  return parts.length ? parts.join(" · ") : null;
}

export default function ContentTab({ records }: { workspaceId: string; records: ContentRecordView[] }) {
  const [q, setQ] = useState("");
  const [kindFilter, setKindFilter] = useState("");

  const kinds = useMemo(() => [...new Set(records.map((r) => r.kind))].sort(), [records]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return records.filter((r) => {
      if (kindFilter && r.kind !== kindFilter) return false;
      if (!needle) return true;
      return (
        r.title.toLowerCase().includes(needle) ||
        (r.angle ?? "").toLowerCase().includes(needle) ||
        (r.channel ?? "").toLowerCase().includes(needle)
      );
    });
  }, [records, q, kindFilter]);

  return (
    <div className="flex flex-col gap-4">
      <div className={infoNoteCls}>
        Content memory keeps every angle consistent — agents check here before reusing one, and performance
        flows back in from your analytics integrations to close the learn → create → measure → learn loop.
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 text-[13px] text-stone-500">
          <FileText size={14} />
          <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} className={inputCls} aria-label="Filter by kind">
            <option value="">All kinds</option>
            {kinds.map((k) => (
              <option key={k} value={k}>{k.replace(/_/g, " ")}</option>
            ))}
          </select>
        </div>
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search content…" className={`${inputCls} w-48 pl-8`} />
        </div>
        <span className="ml-auto text-[12.5px] text-stone-400">{filtered.length} record{filtered.length === 1 ? "" : "s"}</span>
      </div>

      <div className={tableShell}>
        <table className="w-full text-[13px]">
          <thead className={theadCls}>
            <tr>
              <th className={thCls}>Title</th>
              <th className={`${thCls} w-32`}>Kind</th>
              <th className={`${thCls} w-28`}>Channel</th>
              <th className={thCls}>Angle</th>
              <th className={`${thCls} w-40`}>Performance</th>
              <th className={`${thCls} w-28`}>Created</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr className={rowCls}>
                <td colSpan={6} className="px-3 py-8 text-center text-stone-500">
                  {records.length === 0
                    ? "Nothing made yet — content agents create lands here automatically, with its angle and channel."
                    : "No records match your filters."}
                </td>
              </tr>
            )}
            {filtered.map((r) => {
              const perf = perfSummary(r.performance);
              return (
                <tr key={r.id} className={rowCls}>
                  <td className="max-w-[300px] truncate px-3 py-2.5 font-medium text-stone-900" title={r.title}>{r.title}</td>
                  <td className="px-3 py-2.5"><Chip tone="slate">{r.kind.replace(/_/g, " ")}</Chip></td>
                  <td className="px-3 py-2.5 text-stone-600">{r.channel ?? "—"}</td>
                  <td className="max-w-[260px] truncate px-3 py-2.5 text-stone-600" title={r.angle ?? ""}>{r.angle ?? "—"}</td>
                  <td className="px-3 py-2.5">
                    {perf ? <span className="text-[12.5px] text-stone-700">{perf}</span> : <span className="text-[12px] italic text-stone-400">not measured yet</span>}
                  </td>
                  <td className="px-3 py-2.5 text-stone-500">{fmtDate(r.createdAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
