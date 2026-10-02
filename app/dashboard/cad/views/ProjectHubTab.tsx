"use client";

// Marketr — CAD + Hardware slice 4: project hub.
// Project-level dashboard for a CAD project: rollup overview, tasks/issues,
// parts inventory, and suppliers. Agentic OS design system
// (docs/design/DESIGN.md): canvas page, white surfaces, black primary
// actions, Lucide icons only, tokens only. The agent status color+shape
// language is reserved for agent states — task/inventory status here is
// text-only monochrome.

import { useState } from "react";
import {
  LayoutDashboard,
  ListTodo,
  Package,
  Truck,
  Loader2,
} from "lucide-react";
import { ProjectHubOverview } from "./ProjectHubOverview";
import { ProjectHubTasks } from "./ProjectHubTasks";
import { ProjectHubInventory } from "./ProjectHubInventory";
import { ProjectHubSuppliers } from "./ProjectHubSuppliers";

const TABS = [
  { key: "overview", label: "Overview", icon: LayoutDashboard },
  { key: "tasks", label: "Tasks & issues", icon: ListTodo },
  { key: "inventory", label: "Inventory", icon: Package },
  { key: "suppliers", label: "Suppliers", icon: Truck },
] as const;

type HubTab = (typeof TABS)[number]["key"];

export function ProjectHubTab({ projectId }: { projectId: string }) {
  const [tab, setTab] = useState<HubTab>("overview");

  return (
    <div>
      <div className="mb-4 flex gap-1 border-b border-line" role="tablist" aria-label="Project hub sections">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.key)}
              className={`flex h-11 items-center gap-2 border-b-2 px-4 text-sm font-semibold transition-colors ${
                active ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === "overview" && <ProjectHubOverview projectId={projectId} />}
      {tab === "tasks" && <ProjectHubTasks projectId={projectId} />}
      {tab === "inventory" && <ProjectHubInventory projectId={projectId} />}
      {tab === "suppliers" && <ProjectHubSuppliers projectId={projectId} />}
    </div>
  );
}

export function LoadingNote({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 p-4 text-sm text-muted">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      {label}…
    </div>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return <p className="text-sm text-failed-text">{message}</p>;
}

/** Monochrome status pill. Task/inventory status is text-only — the agent
 *  status color+shape language is reserved for agent states. */
export function StatusPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-canvas px-2.5 py-1 text-xs font-semibold text-ink">
      {children}
    </span>
  );
}

export function money(value: number | null | undefined): string {
  if (value == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}
