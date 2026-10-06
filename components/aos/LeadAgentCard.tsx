// ShapesOS — the lead agent's card (Overview): the agent-card header band in
// the lead's CURRENT state, the lead's identity (monogram + name), the
// mission it is on with its progress, one action, and its sub-agents
// branching beneath it (AgentTree). One lead per workspace; sub-agents are
// never drawn as free-floating peers.

import Link from "next/link";
import type { AgentTree as AgentTreeData } from "@/lib/aos/agents";
import { LEAD_AGENT } from "@/lib/aos/agents";
import { progressFraction, stepNumbers } from "@/lib/aos/run-steps";
import { cn } from "@/lib/utils";
// Phase 18.1 (integration): the card's words in the person's language (English by default).
import { createTranslator, type Translator } from "@/lib/i18n";
import { AgentAvatar } from "./AgentAvatar";
import { AgentTree } from "./AgentTree";
import { aosButton } from "./button";
import { CroppedShape, statusSurface } from "./CroppedShape";
import { StatusBadge } from "./StatusBadge";
import { ToolChip } from "./ToolChip";

const EN: Translator = createTranslator("en");

export function LeadAgentCard({
  tree,
  action,
  maxBranches = 6,
  className,
  t = EN,
}: {
  tree: AgentTreeData;
  action?: { label: string; href: string } | null;
  maxBranches?: number;
  className?: string;
  /** The person's translator; English when absent. */
  t?: Translator;
}) {
  const { lead, branches } = tree;
  const p = lead.progress;
  const step = p ? stepNumbers(p.done, p.total) : null;
  return (
    <article className={cn("overflow-hidden rounded-lg bg-paper shadow-hairline", className)} aria-label={t("kit.leadAgentAria", { name: lead.name })}>
      <div className={cn("relative h-[104px] overflow-hidden", statusSurface(lead.status))}>
        <CroppedShape status={lead.status} />
        <StatusBadge status={lead.status} label={t(`status.${lead.status}`)} tone="ink" className="absolute bottom-4 left-5" />
      </div>
      <div className="px-5 pt-4">
        <div className="flex items-start gap-3">
          <AgentAvatar name={lead.name} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <h2 className="text-xl leading-tight font-bold stretch-heading tracking-heading text-ink">{lead.name}</h2>
              <span className="text-sm font-semibold text-muted">{LEAD_AGENT.role === "Lead agent" ? t("kit.leadRole") : LEAD_AGENT.role}</span>
            </div>
            <p className="mt-1 text-md text-muted">{lead.line}</p>
          </div>
          {action ? (
            <Link href={action.href} className={aosButton({ variant: lead.status === "needs" ? "review" : "primary", size: "sm", className: "hidden sm:inline-flex" })}>
              {action.label}
            </Link>
          ) : null}
        </div>
        {lead.missionName ? (
          <div className="mt-3 rounded-md bg-canvas px-3.5 py-3">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate font-semibold text-ink">{lead.missionName}</span>
              {p ? <span className="shrink-0 text-muted tabular-nums">{step ? t("kit.step", step) : t("kit.noSteps")}</span> : null}
            </div>
            {p ? (
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-line" aria-hidden>
                <div
                  className={cn("h-full rounded-full", lead.status === "running" ? "bg-running" : "bg-ink")}
                  style={{ width: `${progressFraction(p.done, p.total) * 100}%` }}
                />
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {LEAD_AGENT.tools.map((t) => (
            <ToolChip key={t} name={t} variant="tag" />
          ))}
        </div>
      </div>
      <div className="px-3 pt-3 pb-3">
        {branches.length ? (
          <AgentTree lead={lead} branches={branches} showLead={false} trunkOffset={27} maxBranches={maxBranches} t={t} />
        ) : (
          <p className="px-2 pb-2 text-md text-muted">{t("kit.noSubAgents")}</p>
        )}
      </div>
      {action ? (
        <div className="border-t border-line px-5 py-3 sm:hidden">
          <Link href={action.href} className={aosButton({ variant: lead.status === "needs" ? "review" : "primary", size: "sm", className: "w-full" })}>
            {action.label}
          </Link>
        </div>
      ) : null}
    </article>
  );
}

export default LeadAgentCard;
