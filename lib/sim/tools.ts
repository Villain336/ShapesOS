// ShapesOS — Phase 19B (WS=engine): Dress Rehearsal town tools for the agent
// surface (listed in lib/chat/tools.ts TOOLS). Same ToolDef contract and
// gates as every tool (executeTool: grant, role, confirmation, audit).
// Commercial layer (entitlement dress_rehearsal). Architecture: lib/sim/engine.ts.
//
//   list_town_runs           safe · Tier 0 · group "workspace" · viewer
//   start_town_rehearsal     publish · Tier 2 (uses credits: asks unless an
//                            automation rule says Auto-run); the estimate
//                            and the HARD cap still apply · group "automation" · editor
//   apply_launch_change      publish · Tier 2 — "do this for real" for a
//                            simulated intervention that moves no money:
//                            after the person's OK it records the change as
//                            a launch-plan note · group "content" · editor
//   fund_launch_ad_campaign  spend · Tier 3 — "do this for real" for a
//                            simulated ad campaign: real ad budget, so it
//                            ALWAYS asks a person, never auto · group "social" · editor
//
// Words matter: authority.ts scans "<name>: <description>" for Tier-3 verbs.
// The first three avoid them on purpose; fund_launch_ad_campaign says
// "spends" on purpose. Heavy modules load lazily (route bundle size).

import type { ToolDef, ToolResult } from "@/lib/chat/tools";
import type { Intervention } from "./scenario";
import { describeIntervention } from "./scenario";

const actorOf = (ctx: { workspaceId: string; userId: string; role: import("@prisma/client").WorkspaceRole }) => ({ workspaceId: ctx.workspaceId, userId: ctx.userId, role: ctx.role });
const service = () => import("./service.server");
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

export const list_town_runs: ToolDef = {
  name: "list_town_runs",
  description: "List this workspace's Dress Rehearsal town runs (simulated residents meeting a launch): status, scenarios, credits used and the adoption range across seeded runs. Synthetic, never representative.",
  kind: "safe",
  minRole: "viewer",
  argsSchema: { type: "object", properties: { limit: { type: "number", description: "How many runs (1-20, default 10)." } } },
  async execute(ctx, args): Promise<ToolResult> {
    try {
      const runs = await (await service()).listTownRuns(actorOf(ctx), Math.min(20, Math.max(1, Number(args.limit) || 10)));
      if (!runs.length) return { summary: "No town rehearsals yet." };
      const lines = runs.map((r) => {
        const a = r.report?.variants.A.finalAdoption;
        const b = r.report?.variants.B?.finalAdoption;
        const range = a ? ` — adoption A ${pct(a.min)}–${pct(a.max)}${b ? `, B ${pct(b.min)}–${pct(b.max)}` : ""} over ${a.n} seeds` : "";
        return `- ${r.id} [${r.status}] ${r.scenarioA.label}${r.scenarioB ? ` vs ${r.scenarioB.label}` : ""}, ${r.population} residents × ${r.days} days, ${r.spentCredits}/${r.capCredits} credits${range}`;
      });
      return { summary: `Town rehearsals (synthetic, not representative):\n${lines.join("\n")}`, details: { runs: runs.map((r) => ({ id: r.id, status: r.status, spentCredits: r.spentCredits, capCredits: r.capCredits })) } };
    } catch (err) {
      return { summary: `Can't list town rehearsals: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

export const start_town_rehearsal: ToolDef = {
  name: "start_town_rehearsal",
  description:
    "Start a Dress Rehearsal town run: simulated residents (from the workspace's personas) meet a launch scenario, optionally A vs B, over 1-30 simulated days and 1-10 seeded runs. Uses credits under a HARD cap: call with estimateOnly true to show the person the estimate first, then with capCredits once they agreed.",
  kind: "publish",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      setup: { type: "object", description: "The run setup: { worldId, population (50-500), segments, days, seeds, mode (live|deep|rules), scenarioA, scenarioB? } — scenario = { label, product: { name, category, priceCents, description }, interventions: [...] }." },
      estimateOnly: { type: "boolean", description: "true = only return the estimate and the suggested cap (no credits are used)." },
      capCredits: { type: "number", description: "The hard credit cap the person agreed to (required to start)." },
    },
    required: ["setup"],
  },
  async execute(ctx, args): Promise<ToolResult> {
    try {
      const svc = await service();
      const { defaultSimDeps } = await import("./deps.server");
      const actor = actorOf(ctx);
      const est = await svc.estimateTown(actor, args.setup, defaultSimDeps);
      const e = est.estimate;
      const estText = `Estimate: about ${e.expectedCalls} model decisions (${e.perResidentDay.expectedCalls} per resident-day), ~${e.expectedCredits} credits expected; the upper bound and suggested hard cap is ${e.capCredits} credits.`;
      if (args.estimateOnly === true || args.capCredits === undefined) return { summary: `${estText} Ask the person to agree to a cap, then call again with capCredits.`, details: { estimate: e } };
      const cap = Math.min(Number(args.capCredits), e.capCredits);
      const run = await svc.startTownRun(actor, { ...(args.setup as object), capCredits: cap, confirmed: true }, defaultSimDeps);
      return { summary: `Started town rehearsal ${run.id} with a hard cap of ${cap} credits. ${estText}`, details: { runId: run.id, capCredits: cap }, touched: [] };
    } catch (err) {
      return { summary: `Couldn't start the town rehearsal: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

const changeArgs = {
  type: "object" as const,
  properties: {
    runId: { type: "string", description: "The town run the change was rehearsed in." },
    variant: { type: "string", description: '"A" or "B".' },
    index: { type: "number", description: "Which intervention of that scenario (0-based)." },
  },
  required: ["runId", "variant", "index"],
};

async function recordLaunchChange(ctx: Parameters<ToolDef["execute"]>[0], args: Record<string, unknown>, kind: "change" | "ads"): Promise<ToolResult> {
  const svc = await service();
  const run = await svc.getTownRun(actorOf(ctx), String(args.runId));
  const scenario = args.variant === "B" ? run.scenarioB : run.scenarioA;
  const iv = scenario?.interventions[Number(args.index)];
  if (!scenario || !iv) return { summary: "That intervention wasn't found in the run." };
  if ((kind === "ads") !== (iv.kind === "ad_campaign")) return { summary: `Use ${kind === "ads" ? "apply_launch_change" : "fund_launch_ad_campaign"} for this intervention.` };
  const { createNote } = await import("@/lib/notes/service");
  const text = describeIntervention(iv);
  const body =
    kind === "ads"
      ? `Approved for real from Dress Rehearsal run ${run.id} (${scenario.label}): ${text}.\n\nThe rehearsal was synthetic. Create the campaign in Ads; ShapesOS asks again there before any money moves.`
      : `Approved for real from Dress Rehearsal run ${run.id} (${scenario.label}): ${text}.\n\nThe rehearsal was synthetic. Make the change in your store and channels.`;
  const note = await createNote({ workspaceId: ctx.workspaceId, createdBy: ctx.userId, title: `Launch change: ${text}`.slice(0, 200), body, tags: ["dress-rehearsal"], sourceRef: `rehearsal:${run.id}` });
  return { summary: `Recorded the approved launch change as a note: ${text}.`, details: { noteId: note.id }, touched: [{ kind: "note", id: note.id, op: "create" }] };
}

export const apply_launch_change: ToolDef = {
  name: "apply_launch_change",
  description: "Do for real a launch change that was rehearsed in a Dress Rehearsal town run (a product drop, new price, opening hours, promotion or event, new location): after the person's OK it is recorded as an approved launch-plan note.",
  kind: "publish",
  minRole: "editor",
  argsSchema: changeArgs,
  async execute(ctx, args) {
    try {
      return await recordLaunchChange(ctx, args, "change");
    } catch (err) {
      return { summary: `Couldn't record the launch change: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

export const fund_launch_ad_campaign: ToolDef = {
  name: "fund_launch_ad_campaign",
  description: "Do for real an ad campaign that was rehearsed in a Dress Rehearsal town run. This spends real ad budget, so a person must approve it every time.",
  kind: "spend",
  minRole: "editor",
  argsSchema: changeArgs,
  async execute(ctx, args) {
    try {
      return await recordLaunchChange(ctx, args, "ads");
    } catch (err) {
      return { summary: `Couldn't record the ad campaign: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

export const SIM_TOOLS: ToolDef[] = [list_town_runs, start_town_rehearsal, apply_launch_change, fund_launch_ad_campaign];

/** Groups (what a task's grant is made of). */
export const SIM_TOOL_GROUP = {
  list_town_runs: "workspace",
  start_town_rehearsal: "automation",
  apply_launch_change: "content",
  fund_launch_ad_campaign: "social",
} as const;

/** Automation actions (Tier by lib/orchestrator/authority.ts). */
export const SIM_TOOL_ACTION: Readonly<Record<string, string>> = {
  list_town_runs: "list_town_runs",
  start_town_rehearsal: "start_town_rehearsal",
  apply_launch_change: "apply_launch_change",
  fund_launch_ad_campaign: "spend_launch_ad_budget",
};

/** The real tool a simulated intervention becomes ("do this for real"). */
export function realActionFor(iv: Intervention): { tool: "apply_launch_change" | "fund_launch_ad_campaign"; label: string } {
  return { tool: iv.kind === "ad_campaign" ? "fund_launch_ad_campaign" : "apply_launch_change", label: describeIntervention(iv) };
}
