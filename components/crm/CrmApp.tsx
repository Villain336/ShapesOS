// Marketr CRM — app shell: tabs, pipeline switcher, data loading, slide-over.
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Plus, SquareArrowOutUpRight, Users, KanbanSquare, TrendingUp, ClipboardList, ReceiptText, Boxes, Truck, FolderKanban, UserRound, type LucideIcon } from "lucide-react";
import type { CrmLead, CrmPipeline } from "./types";
import { formatMoney } from "./types";
import { FilterToolbar, DEFAULT_FILTERS, type LeadFilters } from "./FilterToolbar";
import { LeadsTable } from "./LeadsTable";
import { KanbanBoard } from "./KanbanBoard";
import { LeadSlideOver } from "./LeadSlideOver";
import { ForecastView } from "./ForecastView";
import { FormsTab } from "./FormsTab";
import { InvoicesTab } from "./InvoicesTab";
import { InventoryTab } from "./InventoryTab";
import { PurchaseOrdersTab } from "./PurchaseOrdersTab";
import { ProjectsTab } from "./ProjectsTab";
import { TeamTab } from "./TeamTab";
import { NewLeadModal, PipelineModal, ImportModal } from "./modals";
import { EmptyState } from "./ui";

type Tab = "leads" | "pipeline" | "forecast" | "forms" | "invoicing" | "inventory" | "purchase-orders" | "projects" | "team";

interface Summary {
  count: number;
  totalValueCents: number;
  avgScore: number | null;
}

const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: "leads", label: "Leads", icon: Users },
  { id: "pipeline", label: "Pipeline", icon: KanbanSquare },
  { id: "forecast", label: "Forecast", icon: TrendingUp },
  { id: "forms", label: "Forms", icon: ClipboardList },
  // Phase 17 slice 2: Operations lives under the CRM (Tico-locked).
  { id: "invoicing", label: "Invoicing", icon: ReceiptText },
  // Phase 17 slice 3: inventory + purchase orders, same placement.
  { id: "inventory", label: "Inventory", icon: Boxes },
  { id: "purchase-orders", label: "Purchase orders", icon: Truck },
  // Phase 17 slice 4: projects, same placement.
  { id: "projects", label: "Projects", icon: FolderKanban },
  // Phase 17 slice 5: HR essentials — team directory + leave requests.
  { id: "team", label: "Team", icon: UserRound },
];

export function CrmApp() {
  const [pipelines, setPipelines] = useState<CrmPipeline[]>([]);
  const [activePipelineId, setActivePipelineId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("leads");
  const [filters, setFilters] = useState<LeadFilters>(DEFAULT_FILTERS);
  const [leads, setLeads] = useState<CrmLead[]>([]);
  const [trends, setTrends] = useState<Record<string, number[]>>({});
  const [summary, setSummary] = useState<Summary>({ count: 0, totalValueCents: 0, avgScore: null });
  const [owners, setOwners] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [modal, setModal] = useState<"newLead" | "newPipeline" | "import" | null>(null);

  const pipeline = useMemo(
    () => pipelines.find((p) => p.id === activePipelineId) ?? null,
    [pipelines, activePipelineId],
  );

  const loadPipelines = useCallback(async (pickFirst = false) => {
    const r = await fetch("/api/crm/pipelines");
    const d = await r.json();
    const list: CrmPipeline[] = d.pipelines ?? [];
    setPipelines(list);
    if (pickFirst && list.length > 0) setActivePipelineId((cur) => cur ?? list[0].id);
    return list;
  }, []);

  const qs = useCallback(() => {
    const p = new URLSearchParams();
    if (activePipelineId) p.set("pipelineId", activePipelineId);
    if (filters.q) p.set("q", filters.q);
    if (filters.stage) p.set("stage", filters.stage);
    if (filters.owner) p.set("owner", filters.owner);
    if (filters.source) p.set("source", filters.source);
    if (filters.scoreBand) p.set("scoreBand", filters.scoreBand);
    if (filters.activeWithinDays) p.set("activeWithinDays", filters.activeWithinDays);
    if (filters.sort) p.set("sort", filters.sort);
    if (filters.starred) p.set("starred", "true");
    p.set("trend", "1");
    return p.toString();
  }, [activePipelineId, filters]);

  const loadLeads = useCallback(
    async (append = false, cursor?: string | null) => {
      if (!activePipelineId) return;
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const q = qs() + (append && cursor ? `&cursor=${cursor}` : "");
        const r = await fetch(`/api/crm/leads?${q}`);
        const d = await r.json();
        setLeads((prev) => (append ? [...prev, ...(d.leads ?? [])] : d.leads ?? []));
        setTrends((prev) => (append ? { ...prev, ...(d.trends ?? {}) } : d.trends ?? {}));
        setSummary(d.summary ?? { count: 0, totalValueCents: 0, avgScore: null });
        setNextCursor(d.nextCursor ?? null);
        setOwners((prev) => {
          const set = new Set(prev);
          for (const l of d.leads ?? []) if (l.ownerName) set.add(l.ownerName);
          return [...set].sort();
        });
      } finally {
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
    },
    [activePipelineId, qs],
  );

  // Boot: pipelines first, then leads.
  useEffect(() => {
    loadPipelines(true).then((list) => {
      // Deep link: ?lead=<id>
      const m = new URLSearchParams(window.location.search).get("lead");
      if (m) setSelectedLeadId(m);
    });
  }, [loadPipelines]);

  // Debounced filter reload.
  useEffect(() => {
    if (!activePipelineId) return;
    const t = setTimeout(() => loadLeads(false), 250);
    return () => clearTimeout(t);
  }, [activePipelineId, qs, loadLeads]);

  const refresh = useCallback(() => {
    loadLeads(false);
    loadPipelines(false);
  }, [loadLeads, loadPipelines]);

  const moveLead = async (leadId: string, toStage: string) => {
    // Optimistic move.
    setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, stage: toStage } : l)));
    try {
      const r = await fetch(`/api/crm/leads/${leadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: toStage }),
      });
      if (!r.ok) throw new Error("move failed");
    } catch {
      refresh();
    }
  };

  const toggleStar = async (lead: CrmLead) => {
    setLeads((prev) => prev.map((l) => (l.id === lead.id ? { ...l, starred: !l.starred } : l)));
    await fetch(`/api/crm/leads/${lead.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ starred: !lead.starred }),
    });
  };

  const doExport = async () => {
    const r = await fetch(`/api/crm/leads/export?${qs()}`);
    if (!r.ok) return;
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `leads-${pipeline?.name ?? "export"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="crm flex h-full flex-col">
      {/* Header: breadcrumb + pipeline switcher + tabs */}
      <div className="border-b border-stone-200 bg-white px-5 pb-0 pt-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[12px] font-medium text-stone-400">Marketr · CRM</p>
            <div className="mt-0.5 flex items-center gap-2">
              <div className="relative">
                <select
                  className="crm-select !border-0 !bg-transparent !pl-0 !pr-8 !text-[20px] !font-bold !text-stone-900"
                  value={activePipelineId ?? ""}
                  onChange={(e) => setActivePipelineId(e.target.value)}
                  aria-label="Active pipeline"
                >
                  {pipelines.map((p) => (
                    <option key={p.id} value={p.id} className="!text-[14px]">
                      {p.name}{p.activeLeads > 0 ? ` (${p.activeLeads})` : ""}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-stone-500" />
              </div>
              <button
                className="rounded-lg p-1.5 text-stone-400 hover:bg-violet-50 hover:text-violet-700"
                onClick={() => setModal("newPipeline")}
                title="New pipeline"
              >
                <Plus size={15} strokeWidth={2.5} />
              </button>
            </div>
          </div>
          {pipeline?.client && (
            <span className="crm-chip crm-chip-violet">
              <SquareArrowOutUpRight size={12} /> {pipeline.client.name}
            </span>
          )}
        </div>
        <nav className="mt-2 flex">
          {TABS.map((t) => (
            <button
              key={t.id}
              className="crm-tab inline-flex items-center gap-1.5"
              data-active={tab === t.id}
              onClick={() => setTab(t.id)}
            >
              <t.icon size={15} />
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {tab === "invoicing" ? (
          <InvoicesTab />
        ) : tab === "inventory" ? (
          <InventoryTab />
        ) : tab === "purchase-orders" ? (
          <PurchaseOrdersTab />
        ) : tab === "projects" ? (
          <ProjectsTab />
        ) : tab === "team" ? (
          <TeamTab />
        ) : pipelines.length === 0 && !loading ? (
          <EmptyState
            title="No pipelines yet"
            hint="Create your first pipeline to start tracking leads."
          />
        ) : (
          <>
            {(tab === "leads" || tab === "pipeline") && pipeline && (
              <div className="mb-3">
                <FilterToolbar
                  filters={filters}
                  setFilters={setFilters}
                  stages={pipeline.stages}
                  owners={owners}
                  onNewLead={() => setModal("newLead")}
                  onImport={() => setModal("import")}
                  onExport={doExport}
                />
              </div>
            )}
            {loading && tab !== "forms" ? (
              <p className="py-12 text-center text-sm text-stone-500">Loading…</p>
            ) : (
              <>
                {tab === "leads" && pipeline && (
                  <LeadsTable
                    leads={leads}
                    trends={trends}
                    pipeline={pipeline}
                    onOpen={setSelectedLeadId}
                    onToggleStar={toggleStar}
                    selectedId={selectedLeadId}
                  />
                )}
                {tab === "pipeline" && pipeline && (
                  <KanbanBoard leads={leads} pipeline={pipeline} onOpen={setSelectedLeadId} onMove={moveLead} />
                )}
                {tab === "forecast" && activePipelineId && <ForecastView pipelineId={activePipelineId} />}
                {tab === "forms" && activePipelineId && <FormsTab pipelineId={activePipelineId} />}
              </>
            )}
            {nextCursor && (tab === "leads" || tab === "pipeline") && (
              <div className="mt-3 text-center">
                <button
                  className="crm-btn-ghost !text-[12.5px]"
                  onClick={() => loadLeads(true, nextCursor)}
                  disabled={loadingMore}
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Aggregation status bar */}
      <div className="flex items-center gap-6 border-t border-stone-200 bg-white px-5 py-2.5 text-[12.5px]">
        <span className="text-stone-500">
          <span className="font-bold text-stone-900 tabular-nums">{summary.count}</span> leads in view
        </span>
        <span className="text-stone-500">
          Pipeline <span className="font-bold text-stone-900 tabular-nums">{formatMoney(summary.totalValueCents)}</span>
        </span>
        <span className="text-stone-500">
          Avg score{" "}
          <span className="font-bold text-stone-900 tabular-nums">
            {summary.avgScore != null ? Math.round(summary.avgScore) : "—"}
          </span>
        </span>
        {pipeline && (
          <span className="ml-auto text-stone-400">
            Active leads (all pipelines):{" "}
            <span className="font-semibold text-stone-700 tabular-nums">
              {pipelines.reduce((a, p) => a + p.activeLeads, 0)}
            </span>
          </span>
        )}
      </div>

      {/* Slide-over + modals */}
      {selectedLeadId && pipeline && (
        <LeadSlideOver
          leadId={selectedLeadId}
          pipeline={pipeline}
          onClose={() => setSelectedLeadId(null)}
          onChanged={refresh}
        />
      )}
      {modal === "newLead" && activePipelineId && (
        <NewLeadModal
          pipelines={pipelines}
          defaultPipelineId={activePipelineId}
          onClose={() => setModal(null)}
          onCreated={refresh}
        />
      )}
      {modal === "newPipeline" && (
        <PipelineModal
          onClose={() => setModal(null)}
          onCreated={(p) => {
            setPipelines((prev) => [...prev, p]);
            setActivePipelineId(p.id);
          }}
        />
      )}
      {modal === "import" && activePipelineId && (
        <ImportModal pipelineId={activePipelineId} onClose={() => setModal(null)} onDone={refresh} />
      )}
    </div>
  );
}
