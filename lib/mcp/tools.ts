// Marketr — MCP v1 tool definitions (Phase C, W5).
//
// 10 task-oriented tools (spec §6.4 — never 1:1 REST mirrors). Every handler:
//   - receives ctx (tenant workspaceId from AUTH, never from args — T1),
//   - validates args with a strict zod schema (unknown keys rejected),
//   - re-checks its own scope via the runner (T2),
//   - queries Prisma with workspaceId scoping on every read.
//
// Execution honesty: vendor-backed tools (rank report, SEO audit, keyword
// ideas) return clearly-labeled mock data (`live: false, mock: true`) or
// "live unavailable" — never fabricated data presented as real.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { McpAuthContext } from "./auth";
import type { McpToolName } from "./scopes";
import { readUsageSummary } from "./metering";
import { analyzeSerpUnmetered, ActionError } from "@/lib/serp/analyze";
import { researchKeywordsUnmetered } from "@/lib/keywords/research";
/* INTEGRATION:activepieces */
import {
  FlowNotBoundError,
  isActivepiecesConfigured,
  workspaceFlows,
} from "@/lib/integrations/activepieces";
/* END */
// Phase 4b: Dataset Builder activation.
import { PrismaDatasetBuilderStore } from "@/lib/datasetbuilder/prisma-store";
import { askPublishedDatasets, getLiveBriefNowPackage } from "@/lib/datasetbuilder/activate";
import { DATASET_TYPES } from "@/lib/datasetbuilder/classify";

export interface ToolResult {
  /** JSON-serializable payload. */
  data: Record<string, unknown>;
}

type Handler = (ctx: McpAuthContext, args: Record<string, unknown>) => Promise<ToolResult>;

export interface ToolDef {
  name: McpToolName;
  /** Static, secret-free description (T3/T12 — treated as untrusted downstream). */
  description: string;
  inputSchema: z.ZodTypeAny;
  /** Explicit JSON Schema served in tools/list (kept in sync with inputSchema). */
  inputJsonSchema: Record<string, unknown>;
  handler: Handler;
}

/** Resolve a project by id within the caller's workspace (404-shaped error if foreign). */
async function projectInWorkspace(ctx: McpAuthContext, projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, workspaceId: ctx.workspaceId },
    select: { id: true, domain: true, locale: true, searchEngine: true },
  });
  if (!project) throw new ToolError("project_not_found", "Project not found in this workspace.");
  return project;
}

export class ToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const HONEST_MOCK_NOTE =
  "Mock data for development — connect a live data source for real results. Never treat mock rows as real measurements.";

const tools: ToolDef[] = [
  {
    name: "list_projects",
    description:
      "List the projects in the caller's workspace (name, domain, locale). Read-only, no credits.",
    inputSchema: z.object({}).strict(),
    inputJsonSchema: {"type":"object","properties":{},"required":[],"additionalProperties":false},
    handler: async (ctx) => {
      const projects = await prisma.project.findMany({
        where: { workspaceId: ctx.workspaceId },
        select: { id: true, domain: true, locale: true },
        orderBy: { createdAt: "asc" },
        take: 100,
      });
      return { data: { projects } };
    },
  },
  {
    name: "get_rank_report",
    description:
      "Latest stored ranking snapshot for a project's tracked keywords. Returns the most recent local checks (not a fresh live crawl). Costs 1 credit.",
    inputSchema: z
      .object({ projectId: z.string().min(1), limit: z.number().int().min(1).max(100).default(25) })
      .strict(),
    inputJsonSchema: {"type":"object","properties":{"projectId":{"type":"string"},"limit":{"type":"number"}},"required":["projectId"],"additionalProperties":false},
    handler: async (ctx, args) => {
      const { projectId, limit } = args as { projectId: string; limit: number };
      await projectInWorkspace(ctx, projectId);
      const keywords = await prisma.keyword.findMany({
        where: { projectId, tracked: true },
        orderBy: { phrase: "asc" },
        take: limit,
        include: { rankings: { orderBy: { checkedAt: "desc" }, take: 1 } },
      });
      return {
        data: {
          live: false,
          mock: false,
          note: "Latest stored checks; not a fresh live crawl.",
          projectId,
          rows: keywords.map((k) => ({
            phrase: k.phrase,
            position: k.rankings[0]?.position ?? null,
            url: k.rankings[0]?.url ?? null,
            checkedAt: k.rankings[0]?.checkedAt?.toISOString() ?? null,
          })),
        },
      };
    },
  },
  {
    name: "run_seo_audit",
    description:
      "On-page SEO audit for a project. In this environment live crawling is unavailable, so it returns clearly-labeled mock findings. Costs 30 credits.",
    inputSchema: z.object({ projectId: z.string().min(1) }).strict(),
    inputJsonSchema: {"type":"object","properties":{"projectId":{"type":"string"}},"required":["projectId"],"additionalProperties":false},
    handler: async (ctx, args) => {
      const { projectId } = args as { projectId: string };
      const project = await projectInWorkspace(ctx, projectId);
      // Honest mock (lib/audit/mock.ts convention: mock:true, bannered).
      return {
        data: {
          live: false,
          mock: true,
          note: HONEST_MOCK_NOTE,
          projectId,
          domain: project.domain,
          findings: [
            { category: "missing-title", filePath: "/about.html", detail: "/about.html has no <title> tag.", fixHint: "Add a concise <title> to <head>.", autoFixable: true, mock: true },
            { category: "missing-meta-description", filePath: "/index.html", detail: "/index.html has no meta description.", fixHint: "Add a ~150 character meta description.", autoFixable: true, mock: true },
            { category: "missing-alt", filePath: "/index.html", detail: "Hero image has no alt text.", fixHint: "Add descriptive alt text.", autoFixable: true, mock: true },
          ],
        },
      };
    },
  },
  {
    name: "get_keyword_ideas",
    description:
      "Keyword ideas for a seed term. In this environment the keyword data vendor is unavailable, so it returns clearly-labeled mock ideas. Costs 50 credits.",
    inputSchema: z
      .object({ seed: z.string().min(1).max(200), limit: z.number().int().min(1).max(50).default(10) })
      .strict(),
    inputJsonSchema: {"type":"object","properties":{"seed":{"type":"string"},"limit":{"type":"number"}},"required":["seed"],"additionalProperties":false},
    handler: async (ctx, args) => {
      const { seed, limit } = args as { seed: string; limit: number };
      void ctx;
      const ideas = Array.from({ length: limit }, (_, i) => ({
        phrase: `${seed} ${["guide", "tips", "best", "how to", "services", "near me", "cost", "reviews", "2026", "checklist"][i % 10]}`,
        volume: null,
        difficulty: null,
        mock: true,
      }));
      return { data: { live: false, mock: true, note: HONEST_MOCK_NOTE, seed, ideas } };
    },
  },
  {
    name: "draft_content_brief",
    description:
      "Draft a deterministic content-brief skeleton for a keyword (structure only — no AI copy in this environment). Costs 5 credits.",
    inputSchema: z
      .object({ keyword: z.string().min(1).max(200), projectId: z.string().min(1).optional() })
      .strict(),
    inputJsonSchema: {"type":"object","properties":{"keyword":{"type":"string"},"projectId":{"type":"string"}},"required":["keyword"],"additionalProperties":false},
    handler: async (ctx, args) => {
      const { keyword, projectId } = args as { keyword: string; projectId?: string };
      if (projectId) await projectInWorkspace(ctx, projectId);
      return {
        data: {
          live: false,
          mock: true,
          note: "Structural skeleton only — no AI-generated copy in this environment.",
          keyword,
          projectId: projectId ?? null,
          brief: {
            title: `The complete guide to ${keyword}`,
            intent: "informational (skeleton — verify against SERP)",
            headings: [`What is ${keyword}?`, `Why ${keyword} matters`, `How to choose`, "FAQ", "Next steps"],
            targetWordCount: 1500,
            internalLinks: [],
            mock: true,
          },
        },
      };
    },
  },
  {
    name: "get_site_health",
    description:
      "Workspace site health: connector health statuses and recent audit activity. Read-only local data. Costs 1 credit.",
    inputSchema: z.object({}).strict(),
    inputJsonSchema: {"type":"object","properties":{},"required":[],"additionalProperties":false},
    handler: async (ctx) => {
      const health = await prisma.connectorHealth.findMany({
        where: { workspaceId: ctx.workspaceId },
        select: { connectionId: true, status: true, lastCheckAt: true, lastError: true },
        take: 50,
      });
      return {
        data: {
          live: false,
          mock: false,
          note: "Local connector-health cache; not a live probe.",
          connectors: health.map((h) => ({
            connectionId: h.connectionId,
            status: h.status,
            lastCheckAt: h.lastCheckAt.toISOString(),
            lastError: h.lastError,
          })),
        },
      };
    },
  },
  {
    name: "list_scheduled_skills",
    description:
      "List the workspace's scheduled skills (Phase B automations): trigger, status, last/next run. Read-only, no credits.",
    inputSchema: z.object({}).strict(),
    inputJsonSchema: {"type":"object","properties":{},"required":[],"additionalProperties":false},
    handler: async (ctx) => {
      const schedules = await prisma.scheduledSkill.findMany({
        where: { workspaceId: ctx.workspaceId },
        select: {
          id: true,
          skillId: true,
          triggerType: true,
          cronExpr: true,
          timezone: true,
          eventSource: true,
          status: true,
          lastRunAt: true,
          nextRunAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      return {
        data: {
          schedules: schedules.map((s) => ({
            id: s.id,
            skillId: s.skillId,
            triggerType: s.triggerType,
            cronExpr: s.cronExpr,
            timezone: s.timezone,
            eventSource: s.eventSource,
            status: s.status,
            lastRunAt: s.lastRunAt?.toISOString() ?? null,
            nextRunAt: s.nextRunAt?.toISOString() ?? null,
          })),
        },
      };
    },
  },
  {
    name: "get_usage_summary",
    description:
      "Credit usage summary for the caller's workspace (used vs included, by action, by project). Read-only, no credits.",
    inputSchema: z.object({ projectId: z.string().min(1).optional() }).strict(),
    inputJsonSchema: {"type":"object","properties":{"projectId":{"type":"string"}},"required":[],"additionalProperties":false},
    handler: async (ctx, args) => {
      const { projectId } = args as { projectId?: string };
      if (projectId) await projectInWorkspace(ctx, projectId);
      const res = await readUsageSummary({ workspaceId: ctx.workspaceId, projectId });
      if (!res.ok) throw new ToolError("metering_unavailable", "Usage data is temporarily unavailable.");
      return { data: { usage: res.summary } };
    },
  },
  {
    name: "analyze_serp",
    description:
      "Analyze the search results page for a keyword: top organic results, SERP features (AI Overview, people-also-ask), and a deterministic breakdown (result count, domain diversity). Costs 1 credit. In this environment the data vendor is unavailable, so results are clearly-labeled mock data.",
    inputSchema: z
      .object({
        projectId: z.string().min(1),
        keyword: z.string().min(1).max(200),
        locationCode: z.number().int().positive().optional(),
        device: z.enum(["desktop", "mobile"]).optional(),
      })
      .strict(),
    inputJsonSchema: {"type":"object","properties":{"projectId":{"type":"string"},"keyword":{"type":"string"},"locationCode":{"type":"number"},"device":{"type":"string","enum":["desktop","mobile"]}},"required":["projectId","keyword"],"additionalProperties":false},
    handler: async (ctx, args) => {
      const { projectId, keyword, locationCode, device } = args as {
        projectId: string;
        keyword: string;
        locationCode?: number;
        device?: "desktop" | "mobile";
      };
      // The runner already metered via the mcp_tool_call passthrough
      // (serp_analysis credits) with keyId attribution — use the un-metered
      // core so the tool call is charged exactly once (T14).
      try {
        const { analysis } = await analyzeSerpUnmetered({
          userId: ctx.userId,
          projectId,
          keyword,
          locationCode,
          device,
          actorId: ctx.userId,
        });
        return { data: { analysis } };
      } catch (e) {
        if (e instanceof ActionError) throw new ToolError(e.code, e.message);
        throw e;
      }
    },
  },
  {
    name: "research_keywords",
    description:
      "Full keyword research task for a seed term: seed metrics plus a clustered ideas report (volumes, difficulty, CPC, intent per idea). Costs 40 credits. In this environment the data vendor is unavailable, so results are clearly-labeled mock data. (For the lighter expansion, use get_keyword_ideas.)",
    inputSchema: z
      .object({
        projectId: z.string().min(1),
        seedKeyword: z.string().min(1).max(200),
        locationCode: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .strict(),
    inputJsonSchema: {"type":"object","properties":{"projectId":{"type":"string"},"seedKeyword":{"type":"string"},"locationCode":{"type":"number"},"limit":{"type":"number"}},"required":["projectId","seedKeyword"],"additionalProperties":false},
    handler: async (ctx, args) => {
      const { projectId, seedKeyword, locationCode, limit } = args as {
        projectId: string;
        seedKeyword: string;
        locationCode?: number;
        limit?: number;
      };
      // Same single-charge discipline as analyze_serp (T14).
      try {
        const { report } = await researchKeywordsUnmetered({
          userId: ctx.userId,
          projectId,
          seedKeyword,
          locationCode,
          limit,
          actorId: ctx.userId,
        });
        return { data: { report } };
      } catch (e) {
        if (e instanceof ActionError) throw new ToolError(e.code, e.message);
        throw e;
      }
    },
  },
  /* INTEGRATION:activepieces */
  {
    name: "automation_trigger_flow",
    description:
      "Trigger a published Activepieces webhook flow on the workspace's automation engine with a JSON payload. Free (the engine is the workspace's own sidecar). Only flows with a published \"Catch Webhook\" trigger can be fired externally — schedule/piece triggers run inside the engine. Returns accepted/runId, never fabricated results.",
    inputSchema: z
      .object({
        flowId: z.string().min(1),
        payload: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
    inputJsonSchema: {"type":"object","properties":{"flowId":{"type":"string"},"payload":{"type":"object"}},"required":["flowId"],"additionalProperties":false},
    handler: async (ctx, args) => {
      const { flowId, payload } = args as { flowId: string; payload?: Record<string, unknown> };
      if (!isActivepiecesConfigured()) {
        throw new ToolError(
          "automation_not_connected",
          "Activepieces is not connected: set ACTIVEPIECES_URL and ACTIVEPIECES_API_KEY on the host (Settings → Providers). No flow was triggered.",
        );
      }
      try {
        // Only flows bound to the token's workspace can fire (H6).
        const result = await workspaceFlows(ctx.workspaceId).trigger(flowId, payload ?? {});
        return {
          data: {
            accepted: result.accepted,
            flowId: result.flowId,
            runId: result.runId,
            note: result.runId
              ? "Flow accepted. Use automation_flow_status with this runId to poll it."
              : "Flow accepted, but the engine returned no run id. Use automation_flow_status with flowId to read the newest run.",
          },
        };
      } catch (e) {
        if (e instanceof FlowNotBoundError) throw new ToolError("flow_not_found", e.message);
        throw new ToolError("automation_trigger_failed", e instanceof Error ? e.message : String(e));
      }
    },
  },
  {
    name: "automation_flow_status",
    description:
      "Read the status of an Activepieces flow run: terminal (SUCCEEDED/FAILED/…), start/finish times, and failure detail when present. Pass runId to poll a specific run, or flowId to read the newest run for that flow. Read-only, free.",
    inputSchema: z
      .object({
        runId: z.string().min(1).optional(),
        flowId: z.string().min(1).optional(),
      })
      .strict()
      .refine((v) => v.runId || v.flowId, { message: "runId or flowId is required" }),
    inputJsonSchema: {"type":"object","properties":{"runId":{"type":"string"},"flowId":{"type":"string"}},"required":[],"additionalProperties":false},
    handler: async (ctx, args) => {
      const { runId, flowId } = args as { runId?: string; flowId?: string };
      const flows = workspaceFlows(ctx.workspaceId);
      if (!isActivepiecesConfigured()) {
        throw new ToolError(
          "automation_not_connected",
          "Activepieces is not connected: set ACTIVEPIECES_URL and ACTIVEPIECES_API_KEY on the host (Settings → Providers).",
        );
      }
      try {
        if (runId) {
          const run = await flows.run(runId);
          return { data: { run } };
        }
        const run = await flows.latestRun(flowId as string);
        return {
          data: {
            run,
            note: run ? undefined : "No runs recorded for this flow yet.",
          },
        };
      } catch (e) {
        if (e instanceof FlowNotBoundError) throw new ToolError("flow_not_found", e.message);
        throw new ToolError("automation_status_failed", e instanceof Error ? e.message : String(e));
      }
    },
  },
  /* END */
  // Phase 4b: Dataset Builder activation. Both read only what the tenant
  // explicitly published (RAG + Feed / BriefNow), always with lineage.
  {
    name: "ask_business_data",
    description:
      "Answer a question strictly from the business datasets this workspace published to RAG + Feed (FAQs, products, policies, SOPs, company facts, pricing). Every answer cites Source → Document → Chunk; when nothing matches it says so instead of guessing. Read-only, no credits.",
    inputSchema: z
      .object({ question: z.string().min(1).max(2000), maxCitations: z.number().int().min(1).max(10).optional() })
      .strict(),
    inputJsonSchema: {"type":"object","properties":{"question":{"type":"string","minLength":1,"maxLength":2000},"maxCitations":{"type":"integer","minimum":1,"maximum":10}},"required":["question"],"additionalProperties":false},
    handler: async (ctx, args) => {
      const { question, maxCitations } = args as { question: string; maxCitations?: number };
      const store = new PrismaDatasetBuilderStore(prisma);
      const answer = await askPublishedDatasets(store, ctx.workspaceId, question, maxCitations ?? 3);
      return { data: { ...answer } };
    },
  },
  {
    name: "get_dataset_adapter",
    description:
      "The live BriefNow dataset adapter package (contract briefnow-dataset-adapter/v1) for one published dataset type: every entry with its source, document, chunk and classification lineage. Paged (offset/limit, max 200). This is how a BriefNow connector pulls the tenant's business data. Read-only, no credits.",
    inputSchema: z
      .object({
        type: z.enum(DATASET_TYPES as unknown as [string, ...string[]]),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      })
      .strict(),
    inputJsonSchema: {"type":"object","properties":{"type":{"type":"string","enum":["faq","product_catalog","policy","process_sop","company_fact","pricing"]},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":200}},"required":["type"],"additionalProperties":false},
    handler: async (ctx, args) => {
      const { type, offset, limit } = args as { type: (typeof DATASET_TYPES)[number]; offset?: number; limit?: number };
      const store = new PrismaDatasetBuilderStore(prisma);
      const live = await getLiveBriefNowPackage(store, ctx.workspaceId, type, { offset, limit });
      if (!live) {
        throw new ToolError(
          "dataset_not_published",
          "This dataset type has not been published to BriefNow in this workspace.",
        );
      }
      return { data: { package: live.package, page: live.page } };
    },
  },
];

export function getTool(name: string): ToolDef | undefined {
  return tools.find((t) => t.name === name);
}

export function listTools(): ToolDef[] {
  return tools;
}

/** JSON-Schema for tools/list. */
export function toolInputJsonSchema(tool: ToolDef): Record<string, unknown> {
  return tool.inputJsonSchema;
}
