// Marketr — Platform-change radar UI (Phase 10 M2).
//
// Flagship page. House pattern per app/dashboard/studio/StudioApp.tsx
// (AGENTS.md): page shell bg-canvas p-4 md:p-6, text-xl bold title,
// sub-tabs with Lucide icon + label and ACTIVE = border-ink
// text-ink, dense tables with badge columns and rows
// hover:bg-hover-paper, filter toolbar = dropdowns + search + violet
// button, info notes border-line bg-canvas.
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  CheckCircle2,
  ExternalLink,
  Info,
  ListChecks,
  Loader2,
  Radar,
  RefreshCw,
  Search,
  Zap,
} from "lucide-react";
import { activateOnKey } from "@/lib/ui/keyboard";

// ── Small atoms (same recipe as StudioApp) ───────────────────────────────────

function Chip({
  children,
  tone = "slate",
}: {
  children: React.ReactNode;
  tone?: "slate" | "violet" | "green" | "amber" | "red" | "blue";
}) {
  void tone;
  return (
    <span
      className={"inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-[10px] font-semibold leading-tight text-muted shadow-control"}
    >
      {children}
    </span>
  );
}

const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
const btnPrimary =
  "inline-flex h-control-sm cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:opacity-40";
const btnGhost =
  "inline-flex h-control-sm cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:opacity-40";

// ── Types ────────────────────────────────────────────────────────────────────

interface RadarEvent {
  id: string;
  source: string;
  eventType: "rollout" | "docs_change" | "volatility";
  title: string;
  startedAt: string | null;
  endedAt: string | null;
  url: string | null;
  classificationConfidence: number | null;
  impactedCount: number;
}

interface Impact {
  projectId: string;
  domain: string | null;
  page: string;
  query: string | null;
  deltaClicks: number | null;
  deltaImpressions: number | null;
  impactScore: number | null;
  confidenceBand: [number, number] | null;
  direction?: "declined" | "improved" | "mixed";
}

interface EventDetail {
  event: RadarEvent;
  impacts: Impact[];
  volatility: VolatilityReading[];
}

interface VolatilityReading {
  provider: string;
  label: string;
  available: boolean;
  value: number | null;
  valueLabel: string | null;
  interpretation: string | null;
  observedAt: string | null;
  detailUrl: string;
}

const SOURCE_LABELS: Record<string, string> = {
  status_dashboard: "Search Status",
  search_central: "Search Central",
  bing_blog: "Bing blog",
};

const TYPE_LABELS: Record<string, string> = {
  rollout: "Rollout",
  docs_change: "Docs change",
  volatility: "Volatility",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtDelta(n: number | null): string {
  if (n === null || n === undefined) return "—";
  const r = Math.round(n);
  return `${r > 0 ? "+" : ""}${r.toLocaleString()}`;
}

// ── Events tab ───────────────────────────────────────────────────────────────

function EventsTab() {
  const [events, setEvents] = useState<RadarEvent[]>([]);
  const [fType, setFType] = useState("");
  const [fSource, setFSource] = useState("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [sweeping, setSweeping] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (fType) qs.set("type", fType);
      if (fSource) qs.set("source", fSource);
      if (q.trim()) qs.set("q", q.trim());
      const r = await fetch(`/api/intelligence/radar/events?${qs.toString()}`);
      const d = await r.json();
      setEvents(d.events ?? []);
    } catch {
      // keep previous list on transient failure
    } finally {
      setLoading(false);
    }
  }, [fType, fSource, q]);

  useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const loadDetail = useCallback(async (id: string) => {
    setSelectedId(id);
    setDetailLoading(true);
    try {
      const r = await fetch(`/api/intelligence/radar/event/${id}`);
      const d = await r.json();
      if (r.ok) setDetail(d);
    } catch {
      // keep previous detail
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const runSweep = useCallback(async () => {
    setSweeping(true);
    try {
      await fetch("/api/intelligence/radar/run", { method: "POST" });
    } catch {
      // non-fatal
    } finally {
      setSweeping(false);
      load();
    }
  }, [load]);

  const selected = useMemo(() => events.find((e) => e.id === selectedId) ?? null, [events, selectedId]);

  return (
    <div>
      {/* Filter toolbar: dropdowns + search + violet button */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select value={fType} onChange={(e) => setFType(e.target.value)} className={inputCls}>
          <option value="">All types</option>
          <option value="rollout">Rollout</option>
          <option value="docs_change">Docs change</option>
          <option value="volatility">Volatility</option>
        </select>
        <select value={fSource} onChange={(e) => setFSource(e.target.value)} className={inputCls}>
          <option value="">All sources</option>
          <option value="status_dashboard">Search Status Dashboard</option>
          <option value="search_central">Search Central changelog</option>
          <option value="bing_blog">Bing Webmaster blog</option>
        </select>
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search events…"
            className={`${inputCls} pl-8`}
          />
        </div>
        <button onClick={runSweep} disabled={sweeping} className={btnPrimary}>
          {sweeping ? <Loader2 size={15} className="aos-spin" /> : <RefreshCw size={15} />}
          Run sweep
        </button>
      </div>

      {/* Dense events table */}
      <div className="overflow-hidden rounded-lg border border-line bg-white">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-line text-xs font-semibold text-muted">
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Event</th>
              <th className="px-3 py-2 font-medium">Source</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Conf</th>
              <th className="px-3 py-2 font-medium">Pages impacted</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr
                key={e.id}
                onClick={() => loadDetail(e.id)}
                tabIndex={0}
                onKeyDown={activateOnKey(() => loadDetail(e.id))}
                className={`cursor-pointer border-b border-line last:border-0 hover:bg-hover-paper ${selectedId === e.id ? "bg-hover-paper" : ""}`}
              >
                <td className="whitespace-nowrap px-3 py-2 text-muted">{fmtDate(e.startedAt)}</td>
                <td className="max-w-[420px] truncate px-3 py-2 font-medium text-ink" title={e.title}>
                  {e.title}
                </td>
                <td className="px-3 py-2 text-muted">{SOURCE_LABELS[e.source] ?? e.source}</td>
                <td className="px-3 py-2">
                  <Chip>{TYPE_LABELS[e.eventType]}</Chip>
                </td>
                <td className="px-3 py-2 text-muted">
                  {e.classificationConfidence !== null ? e.classificationConfidence.toFixed(2) : "—"}
                </td>
                <td className="px-3 py-2">
                  {e.impactedCount > 0 ? (
                    <Chip tone="violet">{e.impactedCount}</Chip>
                  ) : (
                    <span className="text-subtle">—</span>
                  )}
                </td>
              </tr>
            ))}
            {events.length === 0 && !loading && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-[13px] text-subtle">
                  No platform events yet — run the sweep above, or wait for the daily cron.
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-[13px] text-subtle">
                  <Loader2 size={16} className="mx-auto aos-spin" />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Event detail */}
      {selected && (
        <div className="mt-4 rounded-lg border border-line bg-white p-4">
          {detailLoading || !detail || detail.event.id !== selected.id ? (
            <div className="flex items-center gap-2 text-[13px] text-subtle">
              <Loader2 size={15} className="aos-spin" /> Loading event detail…
            </div>
          ) : (
            <EventDetailView detail={detail} />
          )}
        </div>
      )}

      <div className="mt-4 rounded-lg border border-line bg-canvas p-4 text-[12.5px] text-muted">
        <span className="font-medium text-ink">Official sources only. </span>
        Rollouts come from Google's Search Status Dashboard, documentation changes from the Search
        Central changelog RSS, and Bing items from the Bing Webmaster blog RSS. The radar never
        ingests SEO-Twitter, practitioner blogs, or rumor sources — and documentation edits never
        trigger alerts or correlation.
      </div>
    </div>
  );
}

function EventDetailView({ detail }: { detail: EventDetail }) {
  const { event, impacts, volatility } = detail;
  const isRollout = event.eventType === "rollout";
  return (
    <div>
      <div className="flex items-start justify-between border-b border-line px-1 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <Chip>{TYPE_LABELS[event.eventType]}</Chip>
            <Chip tone="blue">{SOURCE_LABELS[event.source] ?? event.source}</Chip>
            {event.classificationConfidence !== null && (
              <span className="text-[11px] text-muted">
                classifier confidence {event.classificationConfidence.toFixed(2)}
              </span>
            )}
          </div>
          <h3 className="mt-1.5 text-[15px] font-bold tracking-tight text-ink">{event.title}</h3>
          <p className="mt-0.5 text-[12.5px] text-muted">
            {fmtDate(event.startedAt)}
            {event.endedAt ? ` → ${fmtDate(event.endedAt)}` : " (rolling out)"}
            {event.url && (
              <>
                {" · "}
                <a
                  href={event.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 text-ink hover:underline"
                >
                  Official source <ExternalLink size={11} />
                </a>
              </>
            )}
          </p>
        </div>
      </div>

      {!isRollout && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-line bg-canvas px-3 py-2 text-[12.5px] text-muted">
          <Info size={14} className="mt-0.5 shrink-0 text-subtle" />
          {event.eventType === "docs_change" ? (
            <span>
              <span className="font-medium text-ink">Documentation edit — no action taken.</span>{" "}
              Docs changes are recorded for the timeline but never correlated against your traffic and
              never trigger alerts.
            </span>
          ) : (
            <span>
              <span className="font-medium text-ink">Volatility signal — context only.</span>{" "}
              Flux readings corroborate timing but are never the source of an impact claim.
            </span>
          )}
        </div>
      )}

      {isRollout && (
        <>
          <h4 className="mb-2 mt-4 flex items-center gap-1.5 text-[13px] font-semibold text-ink">
            <Zap size={14} className="text-ink" /> Page impacts
            <span className="font-normal text-muted">
              — only deltas above the baseline noise band are claimed
            </span>
          </h4>
          <div className="overflow-hidden rounded-lg border border-line">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-line text-xs font-semibold text-muted">
                  <th className="px-3 py-2 font-medium">Page</th>
                  <th className="px-3 py-2 font-medium">Query</th>
                  <th className="px-3 py-2 font-medium">Δ clicks</th>
                  <th className="px-3 py-2 font-medium">Δ impr.</th>
                  <th className="px-3 py-2 font-medium">Direction</th>
                  <th className="px-3 py-2 font-medium">Impact [band]</th>
                </tr>
              </thead>
              <tbody>
                {impacts.map((i, idx) => (
                  <tr key={idx} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className="max-w-[280px] truncate px-3 py-2 font-mono text-[11.5px] text-ink" title={i.page}>
                      {i.page}
                    </td>
                    <td className="max-w-[200px] truncate px-3 py-2 text-muted" title={i.query ?? ""}>
                      {i.query ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-muted">{fmtDelta(i.deltaClicks)}</td>
                    <td className="px-3 py-2 text-muted">{fmtDelta(i.deltaImpressions)}</td>
                    <td className="px-3 py-2">
                      <Chip>{i.direction ?? "—"}</Chip>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted">
                      <span className="font-medium text-ink">
                        {i.impactScore !== null ? i.impactScore.toFixed(2) : "—"}
                      </span>{" "}
                      <span className="text-[11.5px] text-muted">
                        {i.confidenceBand ? `[${i.confidenceBand[0].toFixed(2)}, ${i.confidenceBand[1].toFixed(2)}]` : ""}
                      </span>
                    </td>
                  </tr>
                ))}
                {impacts.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-center text-[13px] text-subtle">
                      No pages moved beyond the noise band for this rollout yet — either the
                      correlation hasn't run, or your properties genuinely didn't move.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <h4 className="mb-2 mt-4 flex items-center gap-1.5 text-[13px] font-semibold text-ink">
            <ListChecks size={14} className="text-ink" /> Verification checklist
          </h4>
          <ul className="space-y-1.5">
            {VERIFICATION_CHECKLIST.map((c) => (
              <li key={c} className="flex items-start gap-2 text-[12.5px] text-muted">
                <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-subtle" />
                {c}
              </li>
            ))}
          </ul>

          <VolatilityPanel volatility={volatility} />
        </>
      )}
    </div>
  );
}

const VERIFICATION_CHECKLIST = [
  "Confirm in Search Console: compare the same pages' clicks/impressions 7 days before vs. after the rollout window — the radar's signal should be visible there too.",
  "Check shape: update hits look the same across unrelated queries on the same pages; site problems cluster on one template or one page type.",
  "Rule out confounders first: recent deploys, robots.txt changes, de-indexed or crawled-not-indexed pages (URL Inspection), and seasonal demand.",
  "Wait until the rollout is marked complete before changing anything — reacting mid-rollout misattributes normal ranking churn to the update.",
  "Document the baseline (this event's impacted pages + queries) so recovery can be measured against it later.",
];

function VolatilityPanel({ volatility }: { volatility: VolatilityReading[] }) {
  if (!volatility || volatility.length === 0) return null;
  return (
    <div className="mt-4 rounded-lg border border-line bg-canvas p-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-medium text-ink">
        <Activity size={13} /> SERP-flux context
        <span className="font-normal text-muted">— corroboration only, never the impact source</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {volatility.map((v) => (
          <span key={v.provider} className="inline-flex items-center gap-1.5 text-[12px] text-muted">
            <Chip tone={v.available ? "amber" : "slate"}>{v.label}</Chip>
            {v.available ? (
              <>
                <span className="font-medium text-ink">{v.valueLabel}</span>
                <span className="text-muted">{v.interpretation}</span>
              </>
            ) : (
              <span className="text-subtle">unreachable this run</span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Volatility tab ───────────────────────────────────────────────────────────

function VolatilityTab() {
  const [readings, setReadings] = useState<VolatilityReading[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/intelligence/radar/volatility")
      .then((r) => r.json())
      .then((d) => setReadings(d.readings ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <div className="overflow-hidden rounded-lg border border-line bg-white">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-line text-xs font-semibold text-muted">
              <th className="px-3 py-2 font-medium">Tracker</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Reading</th>
              <th className="px-3 py-2 font-medium">Interpretation</th>
              <th className="px-3 py-2 font-medium">Observed</th>
            </tr>
          </thead>
          <tbody>
            {readings.map((v) => (
              <tr key={v.provider} className="border-b border-line last:border-0 hover:bg-hover-paper">
                <td className="px-3 py-2">
                  <a
                    href={v.detailUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-medium text-ink hover:underline"
                  >
                    {v.label} <ExternalLink size={11} />
                  </a>
                </td>
                <td className="px-3 py-2">
                  <Chip tone={v.available ? "green" : "slate"}>
                    {v.available ? "live" : "unreachable"}
                  </Chip>
                </td>
                <td className="px-3 py-2 text-muted">{v.valueLabel ?? "—"}</td>
                <td className="px-3 py-2 text-muted">{v.interpretation ?? "—"}</td>
                <td className="px-3 py-2 text-muted">{fmtDate(v.observedAt)}</td>
              </tr>
            ))}
            {readings.length === 0 && !loading && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-[13px] text-subtle">
                  No tracker readings available.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-4 rounded-lg border border-line bg-canvas p-4 text-[12.5px] text-muted">
        <span className="font-medium text-ink">Read-only corroboration. </span>
        These public tracker values confirm whether the SERPs were fluxy around a confirmed
        rollout — they never determine whether your pages were impacted. That claim comes only
        from your own GSC deltas.
      </div>
    </div>
  );
}

// ── Shell ────────────────────────────────────────────────────────────────────

const TABS = [
  { id: "events", label: "Events", icon: Radar },
  { id: "volatility", label: "Volatility", icon: Activity },
] as const;

export function RadarClient() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("events");
  return (
    <div className="bg-canvas p-4 md:p-6">
      <div className="mb-1 flex items-center gap-2">
        <h1 className="text-xl font-bold tracking-tight text-ink">Platform-change radar</h1>
        <Chip tone="violet">
          <Zap size={10} /> Phase 10 · M2
        </Chip>
      </div>
      <p className="mb-4 text-[13px] text-muted">
        Confirmed Google rollouts joined to your own GSC deltas: which updates hit which pages,
        with honest confidence bands. Official sources only.
      </p>

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

      {tab === "events" ? <EventsTab /> : <VolatilityTab />}
    </div>
  );
}
