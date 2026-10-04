// ShapesOS — lead agent with its sub-agents branching beneath it (owner
// rule, DESIGN.md "Agents: one lead, many sub-agents"). The lead comes first;
// each sub-agent hangs off a connector line, indented, in the order the lead
// delegated. Color shows only the CURRENT state (shape + label); identity is
// the name and a black monogram tile.
//
//   tone "paper": Overview / gallery — monogram tiles, status words at right.
//   tone "night": sidebar "Running now" — compact rows on black.
// Data comes from lib/aos/agents.ts deriveAgentTree().

import Link from "next/link";
import { visibleBranches, type AgentNode } from "@/lib/aos/agents";
import { STATUS_META } from "@/lib/aos/status";
import { progressFraction } from "@/lib/aos/run-steps";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "./AgentAvatar";
import { StatusShape } from "./StatusShape";

function MaybeLink({
  href,
  className,
  children,
  label,
  onNavigate,
}: {
  href: string | null;
  className?: string;
  children: React.ReactNode;
  label?: string;
  onNavigate?: () => void;
}) {
  if (!href) return <div className={className}>{children}</div>;
  return (
    <Link href={href} className={className} aria-label={label} onClick={onNavigate}>
      {children}
    </Link>
  );
}

function MiniProgress({ done, total, night }: { done: number; total: number; night?: boolean }) {
  return (
    <span aria-hidden className={cn("block h-1 w-11 shrink-0 overflow-hidden rounded-full", night ? "bg-night-raised" : "bg-line")}>
      <span
        className={cn("block h-full rounded-full", night ? "bg-running-night" : "bg-running")}
        style={{ width: `${progressFraction(done, total) * 100}%` }}
      />
    </span>
  );
}

/** One branch row: connector elbow, shape, name, one-line state. */
function Branch({ node, tone, last, onNavigate }: { node: AgentNode; tone: "paper" | "night"; last: boolean; onNavigate?: () => void }) {
  const night = tone === "night";
  const meta = STATUS_META[node.status];
  return (
    <li className="relative pl-6">
      {/* Vertical trunk (stops at this row's middle on the last branch) + elbow. */}
      <span
        aria-hidden
        className={cn("absolute left-0 w-0.5", night ? "bg-night-line" : "bg-line", last ? "top-0 h-1/2" : "inset-y-0")}
      />
      <span aria-hidden className={cn("absolute top-1/2 left-0 h-0.5 w-4", night ? "bg-night-line" : "bg-line")} />
      <MaybeLink
        href={node.href}
        onNavigate={onNavigate}
        label={`${node.name}: ${meta.label}. ${node.line}`}
        className={cn(
          "flex items-center gap-3 rounded-sm transition-[background-color] duration-150",
          night ? "min-h-12 px-2 py-1.5 hover:bg-night-hover" : "min-h-14 px-2.5 py-2 hover:bg-hover-paper",
        )}
      >
        {/* Night rows lead with the state shape (kit sidebar); paper rows with
            the monogram, the state word sits at the right. */}
        {night ? <StatusShape status={node.status} size={11} tone="night" label={meta.label} /> : <AgentAvatar name={node.name} size="sm" />}
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate font-semibold", night ? "text-md leading-5 text-paper" : "text-base leading-5 text-ink")}>
            {node.name}
          </span>
          <span className={cn("block truncate", night ? "text-xs text-night-muted" : "text-md text-muted")}>{node.line}</span>
        </span>
        {night ? null : (
          <span className="hidden shrink-0 items-center gap-1.5 text-sm font-semibold text-ink sm:inline-flex">
            <StatusShape status={node.status} size={9} live={false} />
            {meta.label}
          </span>
        )}
      </MaybeLink>
    </li>
  );
}

export function AgentTree({
  lead,
  branches,
  tone = "paper",
  showLead = true,
  maxBranches,
  trunkOffset,
  onNavigate,
  className,
}: {
  lead: AgentNode;
  branches: AgentNode[];
  tone?: "paper" | "night";
  /** Hide the lead row when the surrounding card already shows it. */
  showLead?: boolean;
  maxBranches?: number;
  /** Left offset (px) of the connector trunk; defaults to under the lead's shape. */
  trunkOffset?: number;
  /** Called when a row link is followed (closes the mobile drawer). */
  onNavigate?: () => void;
  className?: string;
}) {
  const night = tone === "night";
  const meta = STATUS_META[lead.status];
  // When space is short, finished branches make way first; order is kept.
  const { shown, hidden } = maxBranches ? visibleBranches(branches, maxBranches) : { shown: branches, hidden: 0 };
  return (
    <div className={cn("flex flex-col", className)}>
      {showLead ? (
        <MaybeLink
          href={lead.href}
          onNavigate={onNavigate}
          label={`${lead.name}, lead agent: ${meta.label}. ${lead.line}`}
          className={cn(
            "flex items-center gap-3 rounded-sm transition-[background-color] duration-150",
            night ? "min-h-12 px-2 py-1.5 hover:bg-night-hover" : "min-h-14 px-2.5 py-2 hover:bg-hover-paper",
          )}
        >
          {night ? <StatusShape status={lead.status} size={12} tone="night" label={meta.label} /> : <AgentAvatar name={lead.name} size="md" />}
          <span className="min-w-0 flex-1">
            <span className={cn("block truncate font-semibold", night ? "text-md leading-5 text-paper" : "text-base leading-5 text-ink")}>
              {lead.name}
              <span className={cn("ml-1.5 font-normal", night ? "text-night-muted" : "text-muted")}>· Lead</span>
            </span>
            <span className={cn("block truncate", night ? "text-xs text-night-muted" : "text-md text-muted")}>{lead.line}</span>
          </span>
          {lead.progress && lead.status === "running" ? <MiniProgress done={lead.progress.done} total={lead.progress.total} night={night} /> : null}
          {night ? null : (
            <span className="hidden shrink-0 items-center gap-1.5 text-sm font-semibold text-ink sm:inline-flex">
              <StatusShape status={lead.status} size={9} live={false} />
              {meta.label}
            </span>
          )}
        </MaybeLink>
      ) : null}
      {shown.length ? (
        <ul aria-label={`Sub-agents under ${lead.name}`} style={{ marginLeft: trunkOffset ?? (night ? 13 : 25) }}>
          {shown.map((b, i) => (
            <Branch key={b.key} node={b} tone={tone} last={i === shown.length - 1 && hidden <= 0} onNavigate={onNavigate} />
          ))}
          {hidden > 0 ? (
            <li className="relative pl-6">
              <span aria-hidden className={cn("absolute top-0 left-0 h-1/2 w-0.5", night ? "bg-night-line" : "bg-line")} />
              <span aria-hidden className={cn("absolute top-1/2 left-0 h-0.5 w-4", night ? "bg-night-line" : "bg-line")} />
              <span className={cn("block px-2 py-2 text-xs font-semibold", night ? "text-night-muted" : "text-muted")}>
                {hidden} more {hidden === 1 ? "sub-agent" : "sub-agents"}
              </span>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

export default AgentTree;
