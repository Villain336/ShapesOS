// ShapesOS — Phase 16: a delegation plan (Agentic OS kit).
//
// The lead's plan as a dense table: each task, the sub-agent working it and
// its state (status colour + shape + word — sub-agent states are agent
// states, DESIGN.md), what it waits on, its share of the budget and what it
// used, and what it handed back (or why it didn't). Stopped tasks are a
// neutral chip, never a status colour. IDs are JetBrains Mono.
//
//   variant "table": the run page (all columns).
//   variant "list":  the chat card (state, agent, one line).

import Link from "next/link";
import { STATUS_META } from "@/lib/aos/status";
import { formatBudget, type DelegationPlanView, type DelegationTaskView } from "@/lib/aos/delegation";
import { cn } from "@/lib/utils";
import { StatusShape } from "./StatusShape";

function TaskState({ task }: { task: DelegationTaskView }) {
  if (!task.aos) {
    return (
      <span className="inline-flex h-6 items-center rounded-full bg-paper px-2.5 text-xs font-semibold text-muted shadow-control">
        {task.label}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm font-semibold text-ink">
      <StatusShape status={task.aos} size={9} live={task.aos === "running"} />
      {task.aos === "failed" || task.aos === "needs" || task.aos === "queued" ? task.label : STATUS_META[task.aos].label}
    </span>
  );
}

function outcome(task: DelegationTaskView): string {
  if (task.error && task.status !== "succeeded") return task.error;
  if (task.summary) return task.summary;
  if (task.status === "awaiting_confirmation") return "Waiting for your OK in the chat";
  if (task.status === "pending") return task.dependsOn.length ? `After ${task.dependsOn.join(", ")}` : "Waiting for a free slot";
  return "Working on it";
}

export function DelegationPlan({ plan, variant = "table", className }: { plan: DelegationPlanView; variant?: "table" | "list"; className?: string }) {
  if (variant === "list") {
    return (
      <ul className={cn("divide-y divide-line", className)} aria-label={`Sub-agents: ${plan.line}`}>
        {plan.tasks.map((t) => (
          <li key={t.id} className="flex min-h-11 items-center gap-3 py-2">
            <TaskState task={t} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-md font-semibold text-ink">
                {t.agentName} <span className="aos-mono font-normal text-subtle">{t.id}</span>
              </span>
              <span className="block truncate text-sm text-muted">{outcome(t)}</span>
            </span>
            {t.href ? (
              <Link href={t.href} className="shrink-0 text-sm font-semibold text-ink underline-offset-4 hover:underline">
                Open
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className={cn("overflow-x-auto", className)}>
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead>
          <tr className="border-b border-line text-xs text-muted">
            <th className="px-3 py-2 font-medium">Task</th>
            <th className="px-3 py-2 font-medium">State</th>
            <th className="px-3 py-2 font-medium">Waits on</th>
            <th className="px-3 py-2 font-medium">Budget</th>
            <th className="px-3 py-2 font-medium">Result</th>
          </tr>
        </thead>
        <tbody>
          {plan.tasks.map((t) => (
            <tr key={t.id} className="border-b border-line align-top last:border-0 hover:bg-hover-paper">
              <td className="px-3 py-2.5">
                <div className="font-semibold text-ink">
                  {t.href ? (
                    <Link href={t.href} className="underline-offset-4 hover:underline">
                      {t.agentName}
                    </Link>
                  ) : (
                    t.agentName
                  )}
                </div>
                <div className="aos-mono text-xs text-subtle">
                  {t.id}
                  {t.fixes ? ` · retries ${t.fixes}` : ""}
                </div>
                <div className="mt-0.5 max-w-[280px] text-xs text-muted line-clamp-2">{t.brief}</div>
              </td>
              <td className="px-3 py-2.5">
                <TaskState task={t} />
              </td>
              <td className="px-3 py-2.5">
                {t.dependsOn.length ? <span className="aos-mono text-xs text-ink">{t.dependsOn.join(", ")}</span> : <span className="text-xs text-subtle">—</span>}
              </td>
              <td className="px-3 py-2.5 whitespace-nowrap">
                <div className="text-xs text-ink tabular-nums">{formatBudget(t.budget)}</div>
                {t.used ? <div className="text-xs text-muted tabular-nums">used {formatBudget(t.used)}</div> : null}
              </td>
              <td className="px-3 py-2.5">
                <div className={cn("max-w-[320px] text-sm", t.error && t.status !== "succeeded" ? "text-failed-text" : "text-ink")}>{outcome(t)}</div>
                {t.confidence && t.status === "succeeded" ? <div className="text-xs text-muted">Confidence: {t.confidence}</div> : null}
                {t.openIssues.length ? <div className="text-xs text-muted">Open: {t.openIssues.join("; ")}</div> : null}
                {t.dropped.length ? <div className="text-xs text-subtle">Not allowed: {t.dropped.join(", ")}</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default DelegationPlan;
