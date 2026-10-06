// Marketr — Phase 10 M9: Expert corpus client (Agentic OS).
// Tabs: [Overview] [Sources]. Dense per-source table with tier/license/chunk
// chips; statuses are exactly: "ingested verbatim", "synthesized 1S",
// "pending + reason".

"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Database,
  FileText,
  FlaskConical,
  LayoutDashboard,
  Table2,
} from "lucide-react";
import type { CorpusManifest, CorpusSourceRecord } from "@/lib/intelligence/corpus/types";
import { Chip, inputCls, btnPrimary } from "./brain/brain-ui";

function tierLabel(r: CorpusSourceRecord): string {
  return r.mode === "synthesis-1s" ? "1S" : String(r.tier);
}

function StatusCell({ r }: { r: CorpusSourceRecord }) {
  if (r.status === "pending") {
    return (
      <div className="flex flex-col gap-1">
        <Chip tone="needs">
          <AlertTriangle className="h-3 w-3" /> pending
        </Chip>
        {r.pendingReason && <span className="max-w-[320px] text-xs leading-snug text-muted">{r.pendingReason}</span>}
      </div>
    );
  }
  if (r.mode === "synthesis-1s") {
    return (
      <Chip tone="neutral">
        <FileText className="h-3 w-3" /> Learned through synthesis
      </Chip>
    );
  }
  return (
    <Chip tone="done">
      <CheckCircle2 className="h-3 w-3" /> ingested verbatim
    </Chip>
  );
}

const TABS = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "sources", label: "Sources", icon: Table2 },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function CorpusClient({ manifest }: { manifest: CorpusManifest | null }) {
  const [tab, setTab] = useState<TabId>("overview");
  const [query, setQuery] = useState("");
  const [tierFilter, setTierFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const sources = useMemo(() => manifest?.sources ?? [], [manifest]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sources.filter((r) => {
      if (tierFilter !== "all" && tierLabel(r) !== tierFilter) return false;
      if (statusFilter === "active" && r.status !== "active") return false;
      if (statusFilter === "pending" && r.status !== "pending") return false;
      if (statusFilter === "verbatim" && !(r.status === "active" && r.mode === "verbatim")) return false;
      if (statusFilter === "1s" && !(r.status === "active" && r.mode === "synthesis-1s")) return false;
      if (q && !`${r.title} ${r.author} ${r.id}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [sources, query, tierFilter, statusFilter]);

  const stats = useMemo(() => {
    const active = sources.filter((r) => r.status === "active");
    return {
      total: sources.length,
      verbatim: active.filter((r) => r.mode === "verbatim").length,
      synthesized: active.filter((r) => r.mode === "synthesis-1s").length,
      pending: sources.filter((r) => r.status === "pending").length,
      chunks: sources.reduce((n, r) => n + (r.chunks ?? 0), 0),
    };
  }, [sources]);

  if (!manifest) {
    return (
      <div className="rounded-lg bg-paper p-6 text-sm text-muted shadow-hairline">
        <div className="flex items-center gap-2 font-medium text-ink">
          <Database className="h-4 w-4" /> No corpus built yet
        </div>
        <p className="mt-1">
          The expert corpus has not been ingested in this environment. Run{" "}
          <code className="rounded bg-night px-1 py-0.5 font-mono text-[0.75rem] text-night-text">
            npx tsx scripts/ingest-corpus.mts
          </code>{" "}
          to build{" "}
          <code className="rounded bg-night px-1 py-0.5 font-mono text-[0.75rem] text-night-text">
            data/corpus/
          </code>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Sub-tabs */}
      <div className="flex gap-1 border-b border-line">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium ${
                active ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"
              }`}
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === "overview" && (
        <div className="flex flex-col gap-4">
          {/* Summary strip */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {[
              { label: "Corpus version", value: `v${manifest.corpusVersion}`, icon: Database },
              { label: "Sources", value: String(stats.total), icon: BookOpen },
              { label: "Chunks", value: stats.chunks.toLocaleString(), icon: Table2 },
              {
                label: "Eval precision",
                value: manifest.evalPrecision != null ? `${(manifest.evalPrecision * 100).toFixed(1)}%` : "not run",
                icon: FlaskConical,
              },
              { label: "Updated", value: manifest.updatedAt.slice(0, 10), icon: CheckCircle2 },
            ].map((s) => (
              <div key={s.label} className="rounded-lg bg-paper p-3 shadow-hairline">
                <div className="flex items-center gap-1.5 text-[0.6875rem] font-medium text-muted">
                  <s.icon className="h-3.5 w-3.5" /> {s.label}
                </div>
                <div className="mt-1 text-lg font-bold tracking-tight text-ink">{s.value}</div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="rounded-lg bg-paper p-3 shadow-hairline">
              <div className="text-xs font-semibold text-ink">Ingested verbatim</div>
              <div className="mt-1 text-2xl font-bold text-ink">{stats.verbatim}</div>
              <p className="mt-1 text-xs text-muted">
                Tier 1 (CC-BY-4.0 official platform material) and Tier 2 (public-domain / openly-licensed) sources,
                chunked and embedded as-is.
              </p>
            </div>
            <div className="rounded-lg bg-paper p-3 shadow-hairline">
              <div className="text-xs font-semibold text-ink">Synthesized 1S</div>
              <div className="mt-1 text-2xl font-bold text-ink">{stats.synthesized}</div>
              <p className="mt-1 text-xs text-muted">
                Learn-only sources shipped as ShapesOS-original playbooks — ideas learned, expression ours, factual
                attribution kept. Never verbatim academy text.
              </p>
            </div>
            <div className="rounded-lg bg-paper p-3 shadow-hairline">
              <div className="text-xs font-semibold text-ink">Pending</div>
              <div className="mt-1 text-2xl font-bold text-ink">{stats.pending}</div>
              <p className="mt-1 text-xs text-muted">
                Blocked or uncertain sources — recorded with a reason, never ingested. See the Sources tab.
              </p>
            </div>
          </div>

          <div className="rounded-lg bg-paper p-3 text-xs leading-relaxed text-muted shadow-hairline">
            <span className="font-semibold text-ink">Tier &amp; license doctrine.</span> Tier 1 =
            official platform material (Google Search Central, CC-BY-4.0). Tier 2 = openly-licensed works.
            Tier 1S = learn-only sources (academies, blogs) expressed in ShapesOS&apos;s own words. Wikipedia
            CC-BY-SA material is segregated in a separate asset. Tier 3 purchased material never enters this
            corpus. Last eval: {manifest.evalRunAt ? manifest.evalRunAt.slice(0, 10) : "not run"}.
          </div>
        </div>
      )}

      {tab === "sources" && (
        <div className="flex flex-col gap-3">
          {/* Filter toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            <input
              className={`${inputCls} h-control-sm w-56`}
              placeholder="Search title, author, id…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select className={`${inputCls} h-control-sm`} value={tierFilter} onChange={(e) => setTierFilter(e.target.value)}>
              <option value="all">All tiers</option>
              <option value="1">Tier 1</option>
              <option value="1S">Tier 1S</option>
              <option value="2">Tier 2</option>
            </select>
            <select className={`${inputCls} h-control-sm`} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">All statuses</option>
              <option value="verbatim">ingested verbatim</option>
              <option value="1s">synthesized 1S</option>
              <option value="pending">pending</option>
            </select>
            <span className="text-xs text-subtle">
              {filtered.length} of {sources.length} sources
            </span>
          </div>

          {/* Dense source table */}
          <div className="overflow-x-auto rounded-lg bg-paper shadow-hairline">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs font-semibold text-muted">
                  <th className="px-3 py-2">Title</th>
                  <th className="px-3 py-2">Author</th>
                  <th className="px-3 py-2">Tier</th>
                  <th className="px-3 py-2">License</th>
                  <th className="px-3 py-2 text-right">Chunks</th>
                  <th className="px-3 py-2 text-right">Version</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className="px-3 py-2 font-medium text-ink">
                      {r.title}
                      {r.segregatedAsset && (
                        <span className="ml-1.5 align-middle">
                          <Chip tone="neutral">by-sa asset</Chip>
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted">{r.author}</td>
                    <td className="px-3 py-2">
                      <Chip tone="neutral">{tierLabel(r)}</Chip>
                    </td>
                    <td className="px-3 py-2 text-muted">{r.license === "learn-only" ? "learn-only" : r.license}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink">{r.chunks.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink">v{r.version}</td>
                    <td className="px-3 py-2">
                      <StatusCell r={r} />
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-subtle">
                      No sources match the current filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-2">
            <button className={btnPrimary} disabled title="Corpus builds run from the CLI (scripts/ingest-corpus.mts)">
              <Database className="h-4 w-4" /> Rebuild corpus
            </button>
            <span className="text-xs text-subtle">
              Corpus builds run from the CLI — this button is intentionally disabled in the dashboard.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
