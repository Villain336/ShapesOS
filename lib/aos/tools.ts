// ShapesOS — Phase 18.2 (WS=content): the Activity Monitor's agent tool
// (listed in lib/chat/tools.ts TOOLS).
//
//   list_processes  safe · Tier 0 · group "workspace" · viewer
//
// Read-only: what is running in the workspace right now (and what finished or
// failed in the last day), with cost so far and elapsed time — the same rows
// as /dashboard/activity. An agent can't stop anything with it; Stop is a
// person's button (the page) and goes through the existing stop paths.
// The description avoids every Tier-3 word (lib/orchestrator/authority.ts).

import type { ToolDef, ToolResult } from "@/lib/chat/tools";
import { roleAtLeast } from "@/lib/authz";
import { loadProcessSnapshot } from "./activity.server";
import { formatCost, formatElapsed, elapsedMs } from "./processes";

export const list_processes: ToolDef = {
  name: "list_processes",
  description:
    "List what is running in this workspace right now (agent runs and their sub-agents, background jobs, model batches, code sandboxes, terminal sessions) plus what finished or failed in the last day, with cost so far, elapsed time and the job queue's health. Read-only.",
  kind: "safe",
  minRole: "viewer",
  argsSchema: {
    type: "object",
    properties: {
      live_only: { type: "boolean", description: "Only what is still running or waiting (default true)." },
    },
  },
  async execute(ctx, args): Promise<ToolResult> {
    const liveOnly = args.live_only !== false;
    try {
      const now = Date.now();
      const snap = await loadProcessSnapshot(ctx.workspaceId, { userId: ctx.userId, isAdmin: roleAtLeast(ctx.role, "admin") }, new Date(now));
      const rows = snap.processes.filter((p) => !liveOnly || p.live).slice(0, 40);
      const lines = rows.map((p) => {
        const cost = p.costMicroUsd === null ? "" : `, ${formatCost(p.costMicroUsd)}`;
        return `- [${p.type}] ${p.title} — ${p.state}, ${formatElapsed(elapsedMs(p, now))}${cost}${p.parentKey ? ` (under ${p.parentKey})` : ""} · ${p.key}`;
      });
      const h = snap.health;
      const health = `Queue: ${h.queueDepth} waiting${h.oldestQueuedMs !== null ? ` (oldest ${formatElapsed(h.oldestQueuedMs)})` : ""}, ${h.deadJobs24h} out of retries in 24 h; worker ${h.workerMode}${h.lastHeartbeatMs !== null ? `, last heartbeat ${formatElapsed(h.lastHeartbeatMs)} ago` : ""}.`;
      const head = rows.length ? `${rows.length} ${liveOnly ? "running or waiting" : "in the last day"}:` : liveOnly ? "Nothing is running right now." : "Nothing ran in the last day.";
      return {
        summary: [head, ...lines, health].join("\n"),
        details: { processes: rows.map(({ stop: _stop, ...p }) => p), health: { ...h, cron: undefined, db: undefined } },
      };
    } catch (err) {
      return { summary: `Can't list the processes: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

export const PROCESS_TOOLS: readonly ToolDef[] = [list_processes];
