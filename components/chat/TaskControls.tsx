"use client";

// ShapesOS — Phase 5: the chat's task controls (Agentic OS kit).
//
//   TaskBar        — who is working on this thread (the lead or one sub-agent),
//                    the tools the task is limited to, and Stop while it works.
//   AutoApproveRow — on a pending proposal the server marked auto-eligible
//                    (Phase 14: Tier 0–2), "Let Writer draft content without
//                    asking": writes a per-agent automation rule. Tier 3
//                    (money, irreversible) and destructive calls never get the
//                    row — they always ask.
//
// Everything here is a request; the server decides (lib/agents/grants.ts,
// lib/automation/policy.ts).

import { useId, useState } from "react";
import { Square } from "lucide-react";
import { aosButton } from "@/components/aos/button";
import { ToolChip } from "@/components/aos/ToolChip";
import { AgentAvatar } from "@/components/aos/AgentAvatar";
import { AGENT_MAX_GROUPS, TOOL_GROUP_LABELS, agentDisplayName, isAgentKey, isToolGroup } from "@/lib/agents/grants";
import { actionLabel } from "@/lib/automation/actions";
import { useChat } from "./ChatContext";

/** Groups worth naming on the bar (every task may read its own workspace). */
function shownGroups(groups: readonly string[]): string[] {
  return groups.filter((g) => isToolGroup(g) && g !== "workspace" && g !== "delegate");
}

export function TaskBar({ working }: { working: boolean }) {
  const { threadTask, stop, stopping } = useChat();
  const agentKey = threadTask && isAgentKey(threadTask.agentKey) ? threadTask.agentKey : "lead";
  const name = agentDisplayName(agentKey);
  const groups = shownGroups(threadTask?.allowedTools ?? []);
  // Name the tools when a sub-agent works the task or the grant was narrowed.
  const narrowed = !!threadTask && threadTask.allowedTools.length < AGENT_MAX_GROUPS[agentKey].length;
  const showTools = !!threadTask && (agentKey !== "lead" || narrowed) && groups.length > 0;
  if (!threadTask && !working) return null;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
      <span className="inline-flex items-center gap-2 text-sm font-semibold text-ink">
        <AgentAvatar name={name} size="sm" />
        {agentKey === "lead" ? name : `${name} (sub-agent)`}
      </span>
      {showTools ? (
        <span className="flex flex-wrap items-center gap-1.5" aria-label="Tools this task may use">
          {groups.map((g) => (
            <ToolChip key={g} variant="tag" name={TOOL_GROUP_LABELS[g as keyof typeof TOOL_GROUP_LABELS]} />
          ))}
        </span>
      ) : null}
      {working ? (
        <button
          type="button"
          onClick={() => void stop()}
          disabled={stopping}
          className={aosButton({ variant: "stop", size: "xs", className: "ml-auto" })}
          aria-label="Stop this task"
        >
          <Square className="size-3.5" aria-hidden />
          {stopping ? "Stopping" : "Stop"}
        </button>
      ) : null}
    </div>
  );
}

export function AutoApproveRow({ agentKey, action }: { agentKey: string; action: string }) {
  const { setAutoApprove } = useChat();
  const id = useId();
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = isAgentKey(agentKey) ? agentKey : "lead";
  const label = `Let ${agentDisplayName(key)} ${actionLabel(action).toLowerCase()} without asking`;
  return (
    <div className="mt-3">
      <div className="flex items-center gap-2.5">
        <input
          id={id}
          type="checkbox"
          checked={on}
          disabled={busy}
          onChange={async (e) => {
            const next = e.target.checked;
            setBusy(true);
            setError(null);
            const err = await setAutoApprove(key, action, next);
            setBusy(false);
            if (err) setError(err);
            else setOn(next);
          }}
          className="size-[18px] shrink-0 cursor-pointer appearance-none rounded-key bg-paper shadow-[inset_0_0_0_1.5px_var(--aos-control)] checked:bg-ink checked:shadow-none"
        />
        <label htmlFor={id} className="text-md text-ink">
          {label}
        </label>
      </div>
      <p className="mt-1 text-sm text-muted">
        {error ?? (on ? "Saved. Next time it runs without asking — reply yes to run this one." : "Applies from the next time. Change it in Settings → Automation.")}
      </p>
    </div>
  );
}
