// ShapesOS — Phase 19B (WS=panel): Dress Rehearsal agent tools (listed in
// lib/chat/tools.ts TOOLS). Commercial layer (entitlement dress_rehearsal).
//
//   list_rehearsal_runs  safe · Tier 0 (TOOL_ACTION "list_rehearsal_runs") · group "workspace" · viewer
//   start_page_walk      spend · Tier 2 (TOOL_ACTION "run_page_walk": asks; a
//                        per-agent rule may auto-run it — it moves no money and
//                        is not irreversible) · group "web" · editor. The run's
//                        HARD credit cap is a required argument, shown in the
//                        approval, and enforced by the run like any other.
// Both go through the same service gates as the page (entitlement, role,
// RLS). The service is imported lazily: this file sits in the chat tool
// registry's static graph. Descriptions avoid every Tier-3 word
// (lib/orchestrator/authority.ts).

import type { ToolDef, ToolResult } from "@/lib/chat/tools";

function parseTarget(raw: unknown): unknown {
  const t = typeof raw === "string" ? raw.trim() : "";
  const lp = /^landing_page:([A-Za-z0-9_-]{1,64})$/.exec(t);
  if (lp) return { kind: "landing_page", pageDraftId: lp[1] };
  const site = /^site:([A-Za-z0-9_-]{1,64})(?::(.+))?$/.exec(t);
  if (site) return { kind: "site", siteId: site[1], ...(site[2] ? { path: site[2] } : {}) };
  return { kind: "url", url: t };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const list_rehearsal_runs: ToolDef = {
  name: "list_rehearsal_runs",
  description:
    "List recent Dress Rehearsal page walk runs: what page was walked, status, credits used against the cap, and who landed in each verdict bucket (synthetic, directional — never a single percentage).",
  kind: "safe",
  minRole: "viewer",
  argsSchema: { type: "object", properties: { limit: { type: "number", description: "How many runs (default 5, max 20)." } } },
  async execute(ctx, args): Promise<ToolResult> {
    try {
      const { listRuns } = await import("./service.server");
      const n = Math.min(20, Math.max(1, Number(args.limit) || 5));
      const runs = await listRuns({ workspaceId: ctx.workspaceId, userId: ctx.userId, role: ctx.role }, n, { withReports: true });
      if (runs.length === 0) return { summary: "No Dress Rehearsal runs yet." };
      const lines = runs.map((r) => {
        const d = r.report?.distribution;
        const dist = d ? ` — buy: ${d.buy.join(", ") || "none"}; maybe: ${d.maybe.join(", ") || "none"}; no-buy: ${d["no-buy"].join(", ") || "none"}` : "";
        return `- ${r.id} · ${r.targetLabel} · ${r.status} · ${r.spentCredits}/${r.capCredits} credits${r.modelKind === "fake" ? " · FAKE MODEL" : ""}${dist}`;
      });
      return { summary: `Dress Rehearsal runs (synthetic; directional):\n${lines.join("\n")}`, details: { runs: runs.map((r) => ({ ...r, report: r.report ? { distribution: r.report.distribution, withheld: r.report.withheld } : null })) } };
    } catch (err) {
      return { summary: `Couldn't list Dress Rehearsal runs: ${message(err)}` };
    }
  },
};

export const start_page_walk: ToolDef = {
  name: "start_page_walk",
  description:
    "Start a Dress Rehearsal page walk: synthetic personas built from the workspace's customer interviews walk a page (a public URL, landing_page:<id> or site:<id>) and the run reports who would sign up, ranked objections traced to the interviews, and where attention dropped. Uses credits up to the hard cap you pass (capCredits); the run stops cleanly at the cap. Results are synthetic and directional.",
  kind: "spend",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "A public http(s) URL, landing_page:<pageDraftId> or site:<siteId>[:/path.html]." },
      personaIds: { type: "array", description: "Persona ids to walk (list them in the Dress Rehearsal page).", items: { type: "string" } },
      capCredits: { type: "number", description: "Hard credit cap for the whole run (required, at least 1)." },
      stepCap: { type: "number", description: "Steps per persona (2-15, default 8)." },
    },
    required: ["target", "personaIds", "capCredits"],
  },
  async execute(ctx, args): Promise<ToolResult> {
    const cap = Math.floor(Number(args.capCredits));
    if (!Number.isFinite(cap) || cap < 1) return { summary: "A page walk needs a credit cap of at least 1 credit (capCredits)." };
    const personaIds = Array.isArray(args.personaIds) ? args.personaIds.filter((x): x is string => typeof x === "string") : [];
    try {
      const { startPageWalk } = await import("./service.server");
      const { panelDeps } = await import("./deps.server");
      // The person approved this call with its cap in view (Tier 2) — that is the confirmation.
      const run = await startPageWalk(
        { workspaceId: ctx.workspaceId, userId: ctx.userId, role: ctx.role },
        { target: parseTarget(args.target), personaIds, stepCap: Number(args.stepCap) || undefined, capCredits: cap, confirmed: true },
        panelDeps(),
      );
      return {
        summary: `Queued page walk ${run.id} on ${run.targetLabel}: ${run.personas.length} personas, estimate ${run.estimateCredits} credits, hard cap ${run.capCredits} credits${run.modelKind === "fake" ? " (FAKE MODEL)" : ""}. Results are synthetic and directional; see Dress Rehearsal for the report.`,
        details: { run },
      };
    } catch (err) {
      return { summary: `Couldn't start the page walk: ${message(err)}` };
    }
  },
};

export const PANEL_TOOLS: readonly ToolDef[] = [list_rehearsal_runs, start_page_walk];
