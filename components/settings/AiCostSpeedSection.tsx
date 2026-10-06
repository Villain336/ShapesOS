// ShapesOS — Phase 17 (observability): Settings → Usage → "AI cost & speed".
// Model cost per day, how much of the input the prompt cache served, how fast
// the first token arrives, and the runs that cost the most — all read from
// the same llm_tokens ledger rows that bill the calls (GET /api/usage/ai).
// Agentic OS (docs/design/DESIGN.md): tokens only, white cards on canvas,
// black for data ink (one series), no status colors (nothing here is an
// agent state), sentence case, mono for ids.

"use client";

import { useCallback, useEffect, useState } from "react";
import { cardCls, Notice, type NoticeState } from "./ui";

interface AiCostSpeed {
  days: number;
  calls: number;
  costMicroUsd: number;
  perDay: Array<{ day: string; calls: number; costMicroUsd: number }>;
  cacheHitPct: number | null;
  cacheReadShare: number | null;
  cacheReadShare24h: number | null;
  ttftP50Ms: number | null;
  ttftP95Ms: number | null;
  durationP50Ms: number | null;
  durationP95Ms: number | null;
  byModel: Array<{ model: string; calls: number; costMicroUsd: number; cacheHitPct: number | null }>;
  topRuns: Array<{ runId: string; costMicroUsd: number; calls: number; kind: string | null; agentKey: string | null; label: string | null; createdAt: string | null }>;
}

const RANGES = [7, 14, 30] as const;

function usd(micro: number): string {
  const v = micro / 1_000_000;
  if (v === 0) return "$0.00";
  return v < 1 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}
function pct(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}
function ms(v: number | null): string {
  if (v === null) return "—";
  return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`;
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className={cardCls}>
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums text-ink">{value}</div>
      <div className="text-xs text-muted">{sub}</div>
    </div>
  );
}

/** Cost per day: one series, black bars from a shared baseline; every value also in the table below. */
function CostPerDay({ perDay, days }: { perDay: AiCostSpeed["perDay"]; days: number }) {
  // Fill the empty days so the x-axis is time, not "days with traffic".
  const map = new Map(perDay.map((d) => [d.day, d]));
  const series: AiCostSpeed["perDay"] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    series.push(map.get(day) ?? { day, calls: 0, costMicroUsd: 0 });
  }
  const max = Math.max(1, ...series.map((d) => d.costMicroUsd));
  const [hover, setHover] = useState<number | null>(null);
  const h = hover === null ? null : series[hover];
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-ink">Model cost per day</h3>
        <span className="text-xs tabular-nums text-muted" aria-live="polite">
          {h ? `${h.day} · ${usd(h.costMicroUsd)} · ${h.calls} call${h.calls === 1 ? "" : "s"}` : `Peak ${usd(max === 1 ? 0 : max)}`}
        </span>
      </div>
      <div className="flex h-32 items-end gap-[2px] border-b border-line" role="list" aria-label="Model cost per day">
        {series.map((d, i) => (
          <div
            key={d.day}
            role="listitem"
            tabIndex={0}
            aria-label={`${d.day}: ${usd(d.costMicroUsd)}, ${d.calls} calls`}
            className="group flex h-full flex-1 cursor-default items-end focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            onPointerEnter={() => setHover(i)}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
          >
            <div
              className={`w-full rounded-t-[4px] ${hover === i ? "bg-ink-hover" : "bg-ink"}`}
              style={{ height: d.costMicroUsd > 0 ? `${Math.max(2, (d.costMicroUsd / max) * 100)}%` : "0%" }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs tabular-nums text-subtle">
        <span>{series[0]?.day}</span>
        <span>{series.at(-1)?.day}</span>
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-semibold text-muted">Show as a table</summary>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="py-1 font-medium">Day</th>
              <th className="py-1 text-right font-medium">Calls</th>
              <th className="py-1 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {series.map((d) => (
              <tr key={d.day} className="border-t border-line">
                <td className="py-1.5 tabular-nums text-ink">{d.day}</td>
                <td className="py-1.5 text-right tabular-nums text-ink">{d.calls}</td>
                <td className="py-1.5 text-right tabular-nums text-ink">{usd(d.costMicroUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

export default function AiCostSpeedSection({ workspaceId }: { workspaceId: string }) {
  const [days, setDays] = useState<number>(14);
  const [data, setData] = useState<AiCostSpeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/usage/ai?workspaceId=${encodeURIComponent(workspaceId)}&days=${days}`);
      if (!r.ok) throw new Error("Couldn't load AI cost and speed. Reload the page to try again.");
      setData(await r.json());
      setNotice(null);
    } catch (err) {
      setNotice({ kind: "error", message: err instanceof Error ? err.message : "Couldn't load AI cost and speed." });
    } finally {
      setLoading(false);
    }
  }, [workspaceId, days]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section id="ai-cost-speed" className="flex flex-col gap-4" aria-labelledby="ai-cost-speed-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="ai-cost-speed-title" className="text-lg font-semibold text-ink">
            AI cost and speed
          </h2>
          <p className="text-sm text-muted">
            What model calls cost (provider prices, before the 1.5× credit charge), how much input the prompt cache
            served, and how fast answers start.
          </p>
        </div>
        <div className="flex items-center gap-2" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={days === r}
              onClick={() => setDays(r)}
              className={`inline-flex h-8 items-center rounded-full px-3 text-[0.8125rem] font-semibold aos-press ${
                days === r ? "bg-ink text-paper" : "bg-paper text-ink shadow-control hover:shadow-outline"
              }`}
            >
              Last {r} days
            </button>
          ))}
        </div>
      </div>

      {notice && <Notice notice={notice} />}

      {!data ? (
        <div className={cardCls}>
          <p className="text-sm text-muted">{loading ? "Loading AI cost and speed…" : "No data."}</p>
        </div>
      ) : data.calls === 0 ? (
        <div className={cardCls}>
          <p className="text-sm text-muted">No model calls in the last {data.days} days. Ask the Assistant something and this fills in.</p>
        </div>
      ) : (
        <div className={`flex flex-col gap-4 ${loading ? "opacity-60" : ""}`}>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Model cost" value={usd(data.costMicroUsd)} sub={`${data.calls.toLocaleString()} calls in ${data.days} days`} />
            <Stat
              label="Cache hits"
              value={pct(data.cacheHitPct)}
              sub={`of calls read the prompt cache · ${pct(data.cacheReadShare)} of input tokens`}
            />
            <Stat label="First token (p50 / p95)" value={ms(data.ttftP50Ms)} sub={`p95 ${ms(data.ttftP95Ms)} · streamed calls`} />
            <Stat label="Call time (p50 / p95)" value={ms(data.durationP50Ms)} sub={`p95 ${ms(data.durationP95Ms)}`} />
          </div>

          {data.cacheReadShare24h !== null && data.cacheReadShare24h < 0.6 && (
            <div className={cardCls}>
              <p className="text-sm text-ink">
                In the last 24 hours only {pct(data.cacheReadShare24h)} of model input came from the prompt cache (the target is
                over 80% on multi-turn chats). Something keeps changing the cached prefix, so each message costs more than it
                should. Admins get a notification when this stays under 60%.
              </p>
            </div>
          )}

          <div className={cardCls}>
            <CostPerDay perDay={data.perDay} days={data.days} />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className={cardCls}>
              <h3 className="mb-3 text-sm font-semibold text-ink">Most expensive runs</h3>
              {data.topRuns.length === 0 ? (
                <p className="text-sm text-muted">No agent runs with model calls in this range.</p>
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {data.topRuns.map((r) => (
                      <tr key={r.runId} className="border-t border-line">
                        <td className="py-2 pr-2">
                          <a href={`/dashboard/runs/${encodeURIComponent(r.runId)}`} className="text-ink underline-offset-2 hover:underline">
                            {r.label ?? `${r.kind ?? "Agent"} run`}
                          </a>
                          <div className="font-mono text-xs text-subtle">{r.runId}</div>
                        </td>
                        <td className="py-2 text-right align-top tabular-nums text-muted">{r.calls} calls</td>
                        <td className="py-2 pl-2 text-right align-top font-medium tabular-nums text-ink">{usd(r.costMicroUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className={cardCls}>
              <h3 className="mb-3 text-sm font-semibold text-ink">By model</h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted">
                    <th className="pb-1 font-medium">Model</th>
                    <th className="pb-1 text-right font-medium">Calls</th>
                    <th className="pb-1 text-right font-medium">Cache hits</th>
                    <th className="pb-1 text-right font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byModel.map((m) => (
                    <tr key={m.model} className="border-t border-line">
                      <td className="py-2 pr-2 font-mono text-xs text-ink">{m.model}</td>
                      <td className="py-2 text-right tabular-nums text-ink">{m.calls}</td>
                      <td className="py-2 text-right tabular-nums text-ink">{pct(m.cacheHitPct)}</td>
                      <td className="py-2 text-right font-medium tabular-nums text-ink">{usd(m.costMicroUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
