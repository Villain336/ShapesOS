// Marketr CRM — Projects tab (Phase 17 slice 4).
// Client delivery work: milestones, progress, time tracking. Operations
// lives UNDER the CRM per Tico's lock. Dense table + badges, Studio house
// pattern. Progress is computed client-side from the milestones JSON.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderKanban, Loader2, Plus, Search } from "lucide-react";
import { ProjectDetail } from "./ProjectDetail";
import { NewProjectModal } from "./NewProjectModal";
import { btnPrimary, chipCls, errorBoxCls, inputCls, selectCls, tableCls, tableWrapCls, trClickableCls } from "./ui";
import { activateOnKey } from "@/lib/ui/keyboard";

export interface OpsProject {
  id: string;
  customerId: string | null;
  name: string;
  milestones: Array<{ title: string; dueAt?: string; status: string }>;
  status: "planning" | "active" | "on_hold" | "completed" | "cancelled";
  leadId: string | null;
  dealId: string | null;
  createdAt: string;
}

export interface CustomerRef {
  id: string;
  name: string;
  company: string | null;
}

const STATUS_FILTERS = ["all", "planning", "active", "on_hold", "completed", "cancelled"] as const;

export const PROJECT_STATUS_META: Record<string, { label: string; tint: string }> = {
  planning: { label: "Planning", tint: "bg-line text-ink" },
  active: { label: "Active", tint: "bg-canvas text-ink" },
  on_hold: { label: "On hold", tint: "bg-canvas text-ink" },
  completed: { label: "Completed", tint: "bg-canvas text-ink" },
  cancelled: { label: "Cancelled", tint: "bg-canvas text-subtle" },
};

export function projectProgressOf(milestones: OpsProject["milestones"]): { done: number; total: number; pct: number } {
  const total = milestones.length;
  const done = milestones.filter((m) => m.status === "done").length;
  return { done, total, pct: total === 0 ? 0 : Math.round((done / total) * 100) };
}

export function ProjectsTab() {
  const [projects, setProjects] = useState<OpsProject[]>([]);
  const [customers, setCustomers] = useState<Record<string, CustomerRef>>({});
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>("all");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "200" });
      if (status !== "all") params.set("status", status);
      const r = await fetch(`/api/ops/projects?${params.toString()}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Failed to load projects.");
      const rows = (d.rows ?? []) as OpsProject[];
      setProjects(rows);
      const ids = [...new Set(rows.map((x) => x.customerId).filter(Boolean))] as string[];
      if (ids.length > 0) {
        const sr = await fetch("/api/ops/projects/customers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids }),
        });
        const sd = await sr.json();
        if (sr.ok) {
          const map: Record<string, CustomerRef> = {};
          for (const c of sd.customers as CustomerRef[]) map[c.id] = c;
          setCustomers(map);
        }
      } else {
        setCustomers({});
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load projects.");
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  const customerLabel = useCallback(
    (p: OpsProject): string => {
      if (!p.customerId) return "—";
      const c = customers[p.customerId];
      return c ? `${c.name}${c.company ? ` · ${c.company}` : ""}` : p.customerId.slice(0, 8);
    },
    [customers],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return projects;
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        customerLabel(p).toLowerCase().includes(needle),
    );
  }, [projects, q, customerLabel]);

  const activeCount = projects.filter((p) => p.status === "active").length;

  const selected = selectedId ? projects.find((p) => p.id === selectedId) ?? null : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-ink">Projects</h2>
          <p className="mt-0.5 text-[13px] text-muted">
            Client delivery work — milestones, progress, and time tracking, linked to CRM leads.
          </p>
        </div>
        <div className="flex items-center gap-4 text-[13px] text-muted">
          <span>
            Active{" "}
            <span className="font-bold text-ink tabular-nums">{activeCount}</span>
          </span>
        </div>
      </div>

      {/* Filter toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          className={selectCls}
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
          aria-label="Filter by status"
        >
          {STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>
              {s === "all" ? "All statuses" : PROJECT_STATUS_META[s].label}
            </option>
          ))}
        </select>
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
          <input
            className={`${inputCls} pl-8`}
            placeholder="Search projects…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <button
          type="button"
          onClick={() => setShowNew(true)}
          className={btnPrimary}
        >
          <Plus size={15} /> New project
        </button>
      </div>

      {error && (
        <div className={errorBoxCls}>
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <Loader2 size={16} className="animate-spin" /> Loading projects…
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-md border border-line bg-canvas px-4 py-10 text-center">
          <FolderKanban size={28} className="mx-auto text-subtle" />
          <p className="mt-2 text-[13px] font-semibold text-ink">No projects yet</p>
          <p className="mt-0.5 text-[13px] text-muted">
            Create a project to track milestones and time against a client.
          </p>
        </div>
      ) : (
        <div className={tableWrapCls}>
          <table className={`${tableCls} min-w-[760px]`}>
            <thead>
              <tr>
                <th>Project</th>
                <th>Customer</th>
                <th>Status</th>
                <th>Progress</th>
                <th>Milestones</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const meta = PROJECT_STATUS_META[p.status];
                const prog = projectProgressOf(p.milestones);
                return (
                  <tr key={p.id} onClick={() => setSelectedId(p.id)} tabIndex={0} onKeyDown={activateOnKey(() => setSelectedId(p.id))} className={trClickableCls}>
                    <td className="font-semibold text-ink">{p.name}</td>
                    <td className="text-ink">{customerLabel(p)}</td>
                    <td>
                      <span className={chipCls}>
                        {meta.label}
                      </span>
                    </td>
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-line">
                          <div
                            className="h-full rounded-full bg-ink"
                            style={{ width: `${prog.pct}%` }}
                          />
                        </div>
                        <span className="text-[12px] text-muted tabular-nums">{prog.pct}%</span>
                      </div>
                    </td>
                    <td className="text-ink tabular-nums">
                      {prog.done}/{prog.total}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <ProjectDetail
          projectId={selected.id}
          onClose={() => setSelectedId(null)}
          onChanged={load}
        />
      )}
      {showNew && (
        <NewProjectModal
          onClose={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false);
            load();
          }}
        />
      )}
    </div>
  );
}
