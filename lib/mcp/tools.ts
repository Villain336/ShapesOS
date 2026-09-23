// Marketr — MCP v1 tool definitions (Phase C, W5).
//
// 8 task-oriented tools (spec §6.4 — never 1:1 REST mirrors). Every handler:
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
