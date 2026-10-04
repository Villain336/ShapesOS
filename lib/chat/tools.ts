// Marketr — AI chat tool definitions (redesign §3a).
//
// Every Marketr capability the assistant can invoke is declared here as a
// ToolDef: name, JSON-schema args (for the system prompt), a safety kind,
// a minimum role, and an implementation that calls existing internal
// services directly (never around them).
//
// Safety kinds:
//   safe        — read-only, runs immediately.
//   spend       — costs API compute/LLM money or runs a heavy job.
//   publish     — moves something toward publication / approvals.
//   destructive — deletes or mutates production data.
// spend/publish/destructive NEVER execute from a single user message —
// lib/chat/agent.ts holds them behind the confirmation gate.

import { prisma } from "@/lib/prisma";
import type { WorkspaceRole } from "@prisma/client";
import { roleAtLeast } from "@/lib/authz";
import { getSeoProvider } from "@/lib/providers";
import { recordUsage } from "@/lib/usage";
import { meter } from "@/lib/metering/service";
import { hourBucket, seedHash } from "@/lib/metering/wiring";
import { visibilityScore, computeAlerts } from "@/lib/rankings";
import { buildDraftPrompt } from "@/lib/content/draft";
import { wordCount, type ContentBrief } from "@/lib/content/brief";
import { inferIntent } from "@/lib/keywords/intent";
import { getLlmProviderFor } from "@/lib/llm";
import { auditProjectSite } from "@/lib/audit/project-audit";
import { generateReport } from "@/lib/pdf/generate";
import { approveAutopilotItem } from "@/lib/seo/autopilot-service";
import { designQr, printLockQr, QrDesignerError } from "@/lib/studio/qr-designer";
import { auditStudio } from "@/lib/studio/service";
// Phase 17 slice 7: Operations tools (read/draft/propose — money writes are
// propose-only behind the Phase 14 gate).
import { OPS_TOOLS } from "./ops-tools";
// Wave 2 context.dev slice 3: agent-facing research tool (spend-kind,
// confirmation-gated, budget-gated before the vendor is hit).
import { research_question } from "@/lib/knowledge/contextdev/research-tool";
// Phase 4b: answers grounded in the tenant's published datasets.
import { PrismaDatasetBuilderStore } from "@/lib/datasetbuilder/prisma-store";
import { askPublishedDatasets } from "@/lib/datasetbuilder/activate";
// Phase 7: OpenAI image generation (media group, spend, draft_image).
import { generate_image } from "@/lib/images/tool";
// Phase 5: tool groups (per-task tool grants).
import { isGroupGranted, type AgentKey, type ToolGroup } from "@/lib/agents/grants";

export type ToolKind = "safe" | "destructive" | "publish" | "spend";

export interface ToolContext {
  projectId: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  /** True only when the user explicitly confirmed this action (chat "yes"). */
  confirmed: boolean;
  /**
   * Turn-scoped set of skill slugs the agent loaded via load_skill this
   * turn (milestone 21). The connector-tool declared-tool gate in
   * lib/chat/connector-tools.ts reads this.
   */
  loadedSkills?: Set<string>;
  /**
   * Phase 5: the agent running this turn ("lead" or a sub-agent key) and the
   * tool groups the task was granted (lib/agents/grants.ts). A missing grant
   * means "no task grant" (legacy callers): the role checks alone apply.
   */
  agentKey?: AgentKey;
  grant?: readonly ToolGroup[] | null;
  /** Phase 5: the AgentRun this turn belongs to (timeline + Stop). */
  runId?: string;
  /** Phase 5: aborted when the run is stopped. */
  signal?: AbortSignal;
}

export interface ToolResult {
  summary: string;
  details?: unknown;
}

/**
 * Phase 8: a tool that appended its own (richer) run event sets
 * details[TOOL_RECORDED_EVENT] = true; the loop's own tool_result event is
 * then marked recorded (kept for the live stream, hidden from the timeline).
 */
export const TOOL_RECORDED_EVENT = "recordedRunEvent";

export interface ToolArgSchema {
  type: string;
  description: string;
}

export interface ToolDef {
  name: string;
  description: string;
  kind: ToolKind;
  minRole: WorkspaceRole;
  argsSchema: {
    type: "object";
    properties: Record<string, ToolArgSchema>;
    required?: string[];
  };
  execute: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function hasRole(ctx: ToolContext, min: WorkspaceRole): boolean {
  return roleAtLeast(ctx.role, min);
}

async function keywordOverview(projectId: string) {
  const keywords = await prisma.keyword.findMany({
    where: { projectId },
    orderBy: { volume: "desc" },
    include: { rankings: { orderBy: { checkedAt: "desc" }, take: 1 } },
  });
  return keywords;
}

// ---------------------------------------------------------------------------
// READ TOOLS (safe)
// ---------------------------------------------------------------------------

const get_keywords: ToolDef = {
  name: "get_keywords",
  description:
    "List the project's saved keywords: phrase, volume, difficulty, intent, list name, tracked flag, and latest rank position.",
  kind: "safe",
  minRole: "viewer",
  argsSchema: {
    type: "object",
    properties: {
      list: { type: "string", description: "Filter by saved list name (optional)." },
      limit: { type: "string", description: "Max keywords to return (default 25)." },
    },
  },
  async execute(ctx, args) {
    const keywords = await keywordOverview(ctx.projectId);
    const list = str(args.list);
    const limit = Math.max(1, Math.min(num(args.limit) ?? 25, 100));
    const rows = keywords
      .filter((k) => !list || (k.list ?? "").toLowerCase() === list.toLowerCase())
      .slice(0, limit)
      .map((k) => ({
        phrase: k.phrase,
        volume: k.volume,
        difficulty: k.difficulty,
        intent: k.intent,
        list: k.list,
        tracked: k.tracked,
        position: k.rankings[0]?.position ?? null,
      }));
    return {
      summary: `${rows.length} keyword${rows.length === 1 ? "" : "s"}${list ? ` in list "${list}"` : ""}`,
      details: rows,
    };
  },
};

const get_rankings: ToolDef = {
  name: "get_rankings",
  description:
    "Rankings summary for the project: tracked keywords with latest position, movement vs previous check, the visibility score, and any rank-drop/gain alerts.",
  kind: "safe",
  minRole: "viewer",
  argsSchema: {
    type: "object",
    properties: {
      limit: { type: "string", description: "Max tracked keywords to return (default 25)." },
    },
  },
  async execute(ctx, args) {
    const keywords = await prisma.keyword.findMany({
      where: { projectId: ctx.projectId },
      include: { rankings: { orderBy: { checkedAt: "desc" }, take: 2 } },
    });
    const limit = Math.max(1, Math.min(num(args.limit) ?? 25, 100));
    const alerts: string[] = [];
    const rows = keywords
      .map((k) => {
        const [latest, previous] = k.rankings;
        for (const a of computeAlerts(
          k.id,
          k.phrase,
          previous?.position ?? null,
          latest?.position ?? null,
          latest?.checkedAt ?? new Date(),
        )) {
          alerts.push(`${a.kind}: "${a.phrase}" ${a.from ?? "?"} → ${a.to ?? "?"}`);
        }
        return {
          phrase: k.phrase,
          tracked: k.tracked,
          position: latest?.position ?? null,
          previousPosition: previous?.position ?? null,
          url: latest?.url ?? null,
          aiOverviewPresent: latest?.aiOverviewPresent ?? false,
          checkedAt: latest?.checkedAt?.toISOString() ?? null,
        };
      })
      .sort((a, b) => (a.position ?? 999) - (b.position ?? 999))
      .slice(0, limit);
    const tracked = keywords.filter((k) => k.tracked);
    const score = visibilityScore(
      tracked.map((k) => ({ volume: k.volume, position: k.rankings[0]?.position ?? null })),
    );
    return {
      summary: `${tracked.length} tracked keywords · visibility score ${score}/100 · ${alerts.length} rank alert${alerts.length === 1 ? "" : "s"}`,
      details: { score, rows, alerts: alerts.slice(0, 20) },
    };
  },
};

const get_competitors: ToolDef = {
  name: "get_competitors",
  description:
    "List the project's tracked competitors (domains) plus the latest competitor-radar events (new keywords, gains, new pages, lost rankings).",
  kind: "safe",
  minRole: "viewer",
  argsSchema: {
    type: "object",
    properties: {
      limit: { type: "string", description: "Max radar events to return (default 15)." },
    },
  },
  async execute(ctx, args) {
    const limit = Math.max(1, Math.min(num(args.limit) ?? 15, 50));
    const [competitors, events] = await Promise.all([
      prisma.competitor.findMany({
        where: { projectId: ctx.projectId },
        orderBy: { addedAt: "asc" },
        select: { id: true, domain: true, addedAt: true },
      }),
      prisma.competitorRadarEvent.findMany({
        where: { projectId: ctx.projectId },
        orderBy: { detectedAt: "desc" },
        take: limit,
      }),
    ]);
    return {
      summary: `${competitors.length} competitor${competitors.length === 1 ? "" : "s"} tracked · ${events.length} recent radar event${events.length === 1 ? "" : "s"}`,
      details: {
        competitors: competitors.map((c) => c.domain),
        events: events.map((e) => ({
          competitor: e.competitorDomain,
          type: e.eventType,
          keyword: e.keywordPhrase,
          detectedAt: e.detectedAt.toISOString(),
          read: e.read,
        })),
      },
    };
  },
};

const get_content: ToolDef = {
  name: "get_content",
  description:
    "Content library overview: counts by status (brief/draft/editing/published) and the most recent content items with their keyword, status and SEO score.",
  kind: "safe",
  minRole: "viewer",
  argsSchema: {
    type: "object",
    properties: {
      status: { type: "string", description: "Filter by status: brief | draft | editing | published." },
      limit: { type: "string", description: "Max items to return (default 15)." },
    },
  },
  async execute(ctx, args) {
    const limit = Math.max(1, Math.min(num(args.limit) ?? 15, 50));
    const status = str(args.status) as "brief" | "draft" | "editing" | "published" | undefined;
    const where = { projectId: ctx.projectId, ...(status ? { status } : {}) };
    const [counts, items] = await Promise.all([
      prisma.contentItem.groupBy({ by: ["status"], where: { projectId: ctx.projectId }, _count: true }),
      prisma.contentItem.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        take: limit,
        include: { keyword: { select: { phrase: true } } },
      }),
    ]);
    return {
      summary: `Content library: ${counts.map((c) => `${c._count} ${c.status}`).join(" · ")}`,
      details: {
        counts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
        items: items.map((i) => ({
          id: i.id,
          keyword: i.keyword?.phrase ?? null,
          status: i.status,
          seoScore: i.seoScore,
          publishedUrl: i.publishedUrl,
          updatedAt: i.updatedAt.toISOString(),
        })),
      },
    };
  },
};

const get_alerts: ToolDef = {
  name: "get_alerts",
  description:
    "Open alert picture: recent alert events (rule, trigger, title, status) plus open site issues by severity.",
  kind: "safe",
  minRole: "viewer",
  argsSchema: {
    type: "object",
    properties: {
      limit: { type: "string", description: "Max alert events to return (default 10)." },
    },
  },
  async execute(ctx, args) {
    const limit = Math.max(1, Math.min(num(args.limit) ?? 10, 50));
    const [events, issues] = await Promise.all([
      prisma.alertEvent.findMany({
        where: { workspaceId: ctx.workspaceId },
        orderBy: { createdAt: "desc" },
        take: limit,
        include: { rule: { select: { name: true } } },
      }),
      prisma.issue.findMany({
        where: { projectId: ctx.projectId, status: "open" },
        orderBy: { detectedAt: "desc" },
        take: 15,
        select: { id: true, type: true, severity: true, url: true, detectedAt: true },
      }),
    ]);
    const bySeverity = issues.reduce<Record<string, number>>((acc, i) => {
      acc[i.severity] = (acc[i.severity] ?? 0) + 1;
      return acc;
    }, {});
    return {
      summary: `${events.length} recent alert event${events.length === 1 ? "" : "s"} · ${issues.length} open issue${issues.length === 1 ? "" : "s"}${Object.keys(bySeverity).length ? ` (${Object.entries(bySeverity).map(([s, n]) => `${n} ${s}`).join(", ")})` : ""}`,
      details: {
        events: events.map((e) => ({
          rule: e.rule.name,
          trigger: e.trigger,
          title: e.title,
          status: e.status,
          createdAt: e.createdAt.toISOString(),
        })),
        openIssues: issues,
      },
    };
  },
};

const get_visibility_score: ToolDef = {
  name: "get_visibility_score",
  description:
    "Composite visibility score time series (0–100 with rankings / AI-presence / freshness / coverage components). Returns the latest snapshots.",
  kind: "safe",
  minRole: "viewer",
  argsSchema: {
    type: "object",
    properties: {
      limit: { type: "string", description: "Max snapshots to return (default 7)." },
    },
  },
  async execute(ctx, args) {
    const limit = Math.max(1, Math.min(num(args.limit) ?? 7, 60));
    const scores = await prisma.visibilityScore.findMany({
      where: { projectId: ctx.projectId },
      orderBy: { date: "desc" },
      take: limit,
    });
    if (!scores.length) {
      return { summary: "No visibility scores computed yet for this project." };
    }
    const latest = scores[0];
    return {
      summary: `Visibility score ${latest.score}/100 as of ${latest.date.toISOString().slice(0, 10)} (${scores.length} snapshot${scores.length === 1 ? "" : "s"} on file)`,
      details: scores.map((s) => ({
        date: s.date.toISOString().slice(0, 10),
        score: s.score,
        components: s.components,
        mock: s.mock,
      })),
    };
  },
};

const get_workflows: ToolDef = {
  name: "get_workflows",
  description:
    "Automation workflows for the project: name, status, enabled, schedule, last run, node counts — plus the latest workflow runs.",
  kind: "safe",
  minRole: "viewer",
  argsSchema: { type: "object", properties: {} },
  async execute(ctx) {
    const [workflows, runs] = await Promise.all([
      prisma.workflow.findMany({
        where: { projectId: ctx.projectId },
        orderBy: { updatedAt: "desc" },
        include: { _count: { select: { nodes: true, edges: true } } },
      }),
      prisma.workflowRun.findMany({
        where: { projectId: ctx.projectId },
        orderBy: { startedAt: "desc" },
        take: 5,
        include: { workflow: { select: { name: true } } },
      }),
    ]);
    return {
      summary: `${workflows.length} workflow${workflows.length === 1 ? "" : "s"}`,
      details: {
        workflows: workflows.map((w) => ({
          id: w.id,
          name: w.name,
          status: w.status,
          enabled: w.enabled,
          schedule: w.schedule,
          nodes: w._count.nodes,
          edges: w._count.edges,
          lastRunAt: w.lastRunAt?.toISOString() ?? null,
        })),
        recentRuns: runs.map((r) => ({
          id: r.id,
          workflow: r.workflow.name,
          status: r.status,
          triggerKind: r.triggerKind,
          startedAt: r.startedAt.toISOString(),
          error: r.error,
        })),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// SKILL LOADING (milestone 21: progressive disclosure, spec §6)
//
// The agent's system prompt lists enabled skill names + descriptions. When
// a task matches one, it calls load_skill to pull the full SKILL.md into
// context BEFORE acting. Loading records the slug in ctx.loadedSkills so
// the connector-tool gate knows which tools the skills declare.
// ---------------------------------------------------------------------------

const load_skill: ToolDef = {
  name: "load_skill",
  description:
    "Load an enabled project's skill by slug: returns the full SKILL.md playbook (name, description, steps, tools it may invoke). Call this BEFORE acting whenever a task matches a skill in the AVAILABLE SKILLS section.",
  kind: "safe",
  minRole: "viewer",
  argsSchema: {
    type: "object",
    properties: {
      slug: { type: "string", description: "Skill slug from the AVAILABLE SKILLS section." },
    },
    required: ["slug"],
  },
  async execute(ctx, args) {
    const slug = str(args.slug);
    if (!slug) throw new Error("slug is required");
    const skill = await prisma.skill.findFirst({
      where: { workspaceId: ctx.workspaceId, slug },
    });
    if (!skill) {
      throw new Error(`No skill with slug "${slug}" is installed in this workspace.`);
    }
    ctx.loadedSkills?.add(skill.slug);
    return {
      summary: `Loaded skill "${skill.name}":\n\n${skill.skillMd.slice(0, 8000)}`,
      details: { slug: skill.slug, name: skill.name, declaredTools: skill.declaredTools },
    };
  },
};

// ---------------------------------------------------------------------------
// WRITE TOOLS (spend / publish / destructive — all behind the confirm gate)
// ---------------------------------------------------------------------------

const research_keywords: ToolDef = {
  name: "research_keywords",
  description:
    "Run keyword research for a seed phrase via the SEO provider. Costs a SERP call (metered). Returns ideas with volume/difficulty — suggestions only, nothing is saved.",
  kind: "spend",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      seed: { type: "string", description: "Seed phrase to research." },
      limit: { type: "string", description: "Max ideas (default 20, max 50)." },
    },
    required: ["seed"],
  },
  async execute(ctx, args) {
    const seed = str(args.seed);
    if (!seed) throw new Error("seed is required");
    if (!hasRole(ctx, "editor")) throw new Error("editor role required");
    const limit = Math.max(1, Math.min(num(args.limit) ?? 20, 50));
    const provider = getSeoProvider();
    const ideas = await provider.keywordIdeas({ seed, limit });
    // Phase C gaps (G1): same underlying action as /api/keywords/ideas —
    // ledger it so the chat path can't bypass metering. Hour-bucketed key (T12).
    await meter({
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      action: "keyword_ideas",
      idempotencyKey: `kwideas:${ctx.projectId}:${seedHash(seed.toLowerCase())}:${limit}:${hourBucket()}`,
      evidenceRef: `chat-research:${seed.slice(0, 60)}`,
    }).catch(() => {});
    await recordUsage(ctx.workspaceId, "serp_calls", 1).catch(() => {});
    const top = ideas.slice(0, limit).map((i: { phrase?: string; volume?: number | null; difficulty?: number | null }) => ({
      phrase: i.phrase ?? "",
      volume: i.volume ?? null,
      difficulty: i.difficulty ?? null,
    }));
    return {
      summary: `${top.length} keyword ideas for "${seed}" (serp_calls +1; none saved — ask me to save the ones you want)`,
      details: top,
    };
  },
};

const create_content_draft: ToolDef = {
  name: "create_content_draft",
  description:
    "Create a content draft for a topic: builds a brief, generates the draft with the LLM, and saves it as a ContentItem in \"draft\" status. PENDING — never auto-published. Costs AI generation (metered).",
  kind: "spend",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      topic: { type: "string", description: "Topic / keyword phrase for the draft." },
      keywordId: { type: "string", description: "Existing saved keyword id to attach (optional)." },
    },
    required: ["topic"],
  },
  async execute(ctx, args) {
    const topic = str(args.topic);
    if (!topic) throw new Error("topic is required");
    if (!hasRole(ctx, "editor")) throw new Error("editor role required");
    const titleCase = topic.replace(/\b\w/g, (c) => c.toUpperCase());
    const brief: ContentBrief = {
      keyword: topic,
      intent: inferIntent(topic),
      h1: `${titleCase}: The Complete Guide`,
      h2s: [],
      paa: [],
      targetWordCount: 1200,
      entities: [],
      sources: [],
      mock: true,
    };
    // Phase D: tool-generated drafts are client-facing → "copy" workload.
    const llm = getLlmProviderFor("copy");
    const body = await llm.generate(buildDraftPrompt(brief));
    const words = wordCount(body);
    const keywordId = str(args.keywordId);
    const keyword = keywordId
      ? await prisma.keyword.findFirst({ where: { id: keywordId, projectId: ctx.projectId } })
      : await prisma.keyword.findFirst({ where: { projectId: ctx.projectId, phrase: topic } });
    const item = await prisma.contentItem.create({
      data: {
        projectId: ctx.projectId,
        keywordId: keyword?.id ?? null,
        status: "draft",
        outlineJson: brief as unknown as object,
        bodyMarkdown: body,
      },
    });
    await recordUsage(ctx.workspaceId, "ai_words", words).catch(() => {});
    // Phase C gaps (G1): same underlying action as /api/content/draft —
    // ledger it so the chat path can't bypass metering.
    await meter({
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      action: "ai_article",
      idempotencyKey: `aichatdraft:${item.id}`,
      evidenceRef: `chat-draft:${item.id}`,
    }).catch(() => {});
    return {
      summary: `Draft created for "${topic}" (${words} words, status "draft" — pending review, not published). Content item ${item.id}.`,
      details: { contentItemId: item.id, topic, words, mock: brief.mock },
    };
  },
};

const run_seo_audit: ToolDef = {
  name: "run_seo_audit",
  description:
    "Run an SEO audit scan over a site in this project. Writes a SiteAudit row plus SiteIssue findings into the audit inbox — it never edits site files. Heavy job: scan the whole file tree.",
  kind: "spend",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      siteId: { type: "string", description: "Site id to audit (optional — defaults to the project's first auditable site)." },
    },
  },
  async execute(ctx, args) {
    if (!hasRole(ctx, "editor")) throw new Error("editor role required");
    // Phase 6: shared with the MCP run_seo_audit tool (lib/audit/project-audit).
    const { site, mock: useMock, result } = await auditProjectSite({
      projectId: ctx.projectId,
      siteId: str(args.siteId) || null,
    });
    return {
      summary: `SEO audit finished on "${site.name}"${useMock ? " (mock scan)" : ""}: ${result.issues.length} issue${result.issues.length === 1 ? "" : "s"} in the inbox — nothing was auto-fixed`,
      details: {
        auditId: result.audit.id,
        issueCount: result.issues.length,
        mock: useMock,
        topIssues: result.issues.slice(0, 10).map((i) => ({
          category: i.category,
          severity: i.severity,
          filePath: i.filePath,
          detail: i.detail.slice(0, 160),
        })),
      },
    };
  },
};

const create_report: ToolDef = {
  name: "create_report",
  description:
    "Generate a branded PDF report from a report template for this project. Renders rankings/visibility data and saves the Report row (status ready). Generation cost (metered).",
  kind: "spend",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      templateId: { type: "string", description: "Report template id (optional — defaults to the project's first template)." },
      period: { type: "string", description: "Report period label (optional)." },
    },
  },
  async execute(ctx, args) {
    if (!hasRole(ctx, "editor")) throw new Error("editor role required");
    const templateId =
      str(args.templateId) ??
      (
        await prisma.reportTemplate.findFirst({
          where: {
            workspaceId: ctx.workspaceId,
            OR: [{ projectId: ctx.projectId }, { projectId: null }],
          },
          orderBy: { updatedAt: "desc" },
          select: { id: true },
        })
      )?.id;
    if (!templateId) {
      const templates = await prisma.reportTemplate.findMany({
        where: { workspaceId: ctx.workspaceId },
        orderBy: { updatedAt: "desc" },
        take: 5,
        select: { id: true, name: true },
      });
      throw new Error(
        `No report template available${templates.length ? ` — pick one: ${templates.map((t) => `${t.name} (${t.id})`).join(", ")}` : " — create one in Reports first"}`,
      );
    }
    const report = await generateReport({
      templateId,
      actor: "user",
      actorId: ctx.userId,
      period: str(args.period),
    });
    return {
      summary: `Report generated: ${report.id} (status "${report.status}")${report.pdfPath ? ` — ${report.pdfPath}` : ""}`,
      details: { reportId: report.id, status: report.status, pdfPath: report.pdfPath },
    };
  },
};

const run_workflow: ToolDef = {
  name: "run_workflow",
  description:
    "Manually trigger an automation workflow run (trigger kind \"manual\"). Creates the WorkflowRun row in \"queued\" status — the automation engine executes it; a workflow's actions can publish content, so this needs confirmation.",
  kind: "publish",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      workflowId: { type: "string", description: "Workflow id (or name — resolved case-insensitively)." },
    },
    required: ["workflowId"],
  },
  async execute(ctx, args) {
    if (!hasRole(ctx, "editor")) throw new Error("editor role required");
    const ref = str(args.workflowId);
    if (!ref) throw new Error("workflowId is required");
    let workflow = await prisma.workflow.findFirst({
      where: { id: ref, projectId: ctx.projectId },
    });
    if (!workflow) {
      workflow = await prisma.workflow.findFirst({
        where: { projectId: ctx.projectId, name: { equals: ref, mode: "insensitive" } },
      });
    }
    if (!workflow) throw new Error(`Workflow "${ref}" not found in this project`);
    if (!workflow.enabled) throw new Error(`Workflow "${workflow.name}" is disabled`);
    const run = await prisma.workflowRun.create({
      data: {
        workflowId: workflow.id,
        projectId: ctx.projectId,
        status: "queued",
        triggerKind: "manual",
        createdBy: ctx.userId,
      },
    });
    return {
      summary: `Workflow "${workflow.name}" triggered — run ${run.id} queued (manual). The automation engine executes runs from the Automations page.`,
      details: { workflowId: workflow.id, workflowName: workflow.name, runId: run.id },
    };
  },
};

const approve_autopilot_item: ToolDef = {
  name: "approve_autopilot_item",
  description:
    "Approve a pending autopilot queue item (pending → approved). Approval moves it toward publishing, so this needs confirmation.",
  kind: "publish",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      itemId: { type: "string", description: "Autopilot item id to approve." },
    },
    required: ["itemId"],
  },
  async execute(ctx, args) {
    if (!hasRole(ctx, "editor")) throw new Error("editor role required");
    const itemId = str(args.itemId);
    if (!itemId) throw new Error("itemId is required");
    await approveAutopilotItem(prisma, {
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      itemId,
      actor: ctx.userId,
    });
    const item = await prisma.autopilotItem.findUnique({
      where: { id: itemId },
      select: { title: true, status: true },
    });
    return {
      summary: `Approved autopilot item "${item?.title ?? itemId}" (now "${item?.status ?? "approved"}")`,
      details: { itemId, status: item?.status },
    };
  },
};

// ---------------------------------------------------------------------------
// PHASE 5 A1 — CHAT-GENERATED QR DESIGNER (Creative Studio)
//
// Chat-first: the user describes the look in natural language ("round QR,
// modules as little snakes, brand colors, logo in the center"). The engine
// designs the module glyph (deterministic procedural glyphs — no LLM key
// needed; a QrGlyphLlm can be plugged in for true AI-designed SVG glyphs),
// tiles it onto the REAL QR matrix, applies the shape mask / colors / logo,
// then runs automated validation (glyph fill, contrast, finder integrity,
// quiet zone, EC forced to H) plus a REAL decoder scan test before anything
// is shown as verified.
//
// The tool NEVER exposes an unverified code as verified: failures return the
// named reason plus the bolder auto-regenerated variant (per spec §A1).
// Success print-locks the asset and returns its sha256 — the hash the
// per-buy approval object binds (spec §4 tracking_links qr_png_url).
// ---------------------------------------------------------------------------

const design_qr_code: ToolDef = {
  name: "design_qr_code",
  description:
    "Design a brand-styled QR code from a natural-language style request (e.g. 'round QR, modules as little snakes, brand colors, logo in the center'). Renders the styled code on the real QR matrix, runs automated validation (glyph fill, contrast, finder integrity, quiet zone, error correction H) and a real decoder scan test. Failures come back with the named reason plus a bolder auto-regenerated variant. A verified design is print-locked and its sha256 hash is returned for the media-buy approval binding. The AI only ever styles the artwork — never the encoded data.",
  kind: "spend",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      stylePrompt: { type: "string", description: "Natural-language style request (required). Describe the look: glyph style, shape, colors, logo, frame CTA." },
      targetUrl: { type: "string", description: "The exact URL the QR must encode and decode to (required, http(s))." },
      foreground: { type: "string", description: "Brand foreground hex color (optional — parsed from the prompt otherwise)." },
      background: { type: "string", description: "Brand background hex color (optional)." },
      logoDataUrl: { type: "string", description: "PNG data URL for the center logo (optional; PNG only)." },
      shapeMask: { type: "string", description: '"square" (default) or "round" — round drops outer modules, keepers finders intact.' },
      frameCta: { type: "string", description: 'Printable frame CTA text, e.g. "Scan for 20% off" (optional).' },
    },
    required: ["stylePrompt", "targetUrl"],
  },
  async execute(ctx, args) {
    if (!hasRole(ctx, "editor")) throw new Error("editor role required");
    const stylePrompt = str(args.stylePrompt);
    const targetUrl = str(args.targetUrl);
    if (!stylePrompt) throw new Error("stylePrompt is required");
    if (!targetUrl) throw new Error("targetUrl is required");
    const brand =
      str(args.foreground) || str(args.background) || str(args.logoDataUrl)
        ? {
            foreground: str(args.foreground),
            background: str(args.background),
            logoDataUrl: str(args.logoDataUrl),
          }
        : undefined;
    let result;
    try {
      result = await designQr({
        targetUrl,
        stylePrompt,
        brand,
        shapeMask: (str(args.shapeMask) as "square" | "round" | undefined) ?? undefined,
        frameCta: str(args.frameCta),
      });
    } catch (err) {
      if (err instanceof QrDesignerError) throw new Error(err.message);
      throw err;
    }

    let lock: Awaited<ReturnType<typeof printLockQr>> | null = null;
    if (result.ok && result.png && result.validation?.ok && result.scanTest.passed) {
      lock = await printLockQr({ workspaceId: ctx.workspaceId, result, targetUrl, createdBy: ctx.userId });
      await auditStudio(
        prisma,
        ctx.workspaceId,
        null,
        "studio_qr_print_locked",
        `QR print-locked via chat for ${targetUrl} (${result.spec.glyphLabel}) — sha256 ${lock.hash.slice(0, 12)}….`,
        "user",
      ).catch(() => {});
    } else {
      await auditStudio(
        prisma,
        ctx.workspaceId,
        null,
        "studio_qr_designed",
        `QR design attempt via chat for ${targetUrl} did not verify: ${(result.validation?.issues ?? []).map((i) => i.code).join(", ") || result.fatal || "unknown"}.`,
        "user",
      ).catch(() => {});
    }

    const v = result.validation;
    const summary = result.ok
      ? `QR designed and scan-verified for ${targetUrl}: ${result.spec.glyphLabel}, ${result.spec.shapeMask} mask, contrast ${v?.metrics.contrastRatio.toFixed(1)}:1, finder integrity ${(100 * (v?.metrics.finderMatchPct ?? 0)).toFixed(0)}%${result.regenerated ? " (bolder auto-regenerated variant — the first style failed validation)" : ""}. Print-locked: sha256 ${lock?.hash.slice(0, 16)}….`
      : `QR design did not verify for ${targetUrl}: ${v?.issues.map((i) => i.message).join(" ") ?? result.fatal ?? "unknown error"}. No unverified code was exposed — nothing was print-locked.`;
    return {
      summary,
      details: {
        ok: result.ok,
        regenerated: result.regenerated,
        attempts: result.attempts,
        fatal: result.fatal ?? null,
        spec: {
          moduleGlyph: result.spec.moduleGlyph,
          glyphLabel: result.spec.glyphLabel,
          shapeMask: result.spec.shapeMask,
          foreground: result.spec.foreground,
          background: result.spec.background,
          finderStyle: result.spec.finderStyle,
          frameCta: result.spec.frameCta,
          errorCorrection: result.spec.errorCorrection,
        },
        validation: v
          ? { ok: v.ok, issues: v.issues, metrics: v.metrics }
          : null,
        scanTest: result.scanTest,
        lock: lock
          ? { hash: lock.hash, qrPngUrl: lock.qrPngUrl, validatedAt: lock.validatedAt }
          : null,
        previewPng: result.png ? `data:image/png;base64,${result.png.toString("base64")}` : null,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// ACTIVEPIECES AUTOMATION (Phase 12, Worker 3 — the automation backbone)
// ---------------------------------------------------------------------------

const trigger_automation_flow: ToolDef = {
  name: "trigger_automation_flow",
  description:
    "Trigger a published Activepieces webhook flow on the workspace's automation engine with a JSON payload. Free (BYO self-hosted engine). Only flows with a published “Catch Webhook” trigger can fire — use automation_flow_status afterwards to poll the run.",
  kind: "spend",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      flowId: { type: "string", description: "Activepieces flow id to trigger." },
      payload: { type: "string", description: "JSON object payload for the flow (optional, default {})." },
    },
    required: ["flowId"],
  },
  async execute(ctx, args) {
    const flowId = str(args.flowId);
    if (!flowId) throw new Error("flowId is required");
    if (!hasRole(ctx, "editor")) throw new Error("editor role required");
    const { isActivepiecesConfigured, workspaceFlows } = await import("@/lib/integrations/activepieces");
    if (!isActivepiecesConfigured()) {
      throw new Error(
        "Activepieces is not connected: set ACTIVEPIECES_URL and ACTIVEPIECES_API_KEY on the host (Settings → Providers). No flow was triggered.",
      );
    }
    let payload: Record<string, unknown> = {};
    if (args.payload !== undefined) {
      try {
        const parsed: unknown = JSON.parse(String(args.payload));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("payload must be a JSON object");
        }
        payload = parsed as Record<string, unknown>;
      } catch (e) {
        throw new Error(`payload must be valid JSON: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Only flows bound to this workspace can fire (H6).
    const result = await workspaceFlows(ctx.workspaceId).trigger(flowId, payload);
    // Ledger the trigger (0-credit visibility event, brandfetch precedent).
    await meter({
      workspaceId: ctx.workspaceId,
      action: "automation_flow_trigger",
      idempotencyKey: `apflow:${ctx.workspaceId}:${flowId}:${hourBucket()}:${seedHash(JSON.stringify(payload))}`,
      evidenceRef: `chat-automation:${flowId}`,
    }).catch(() => {});
    const runLine = result.runId
      ? `run ${result.runId}`
      : "accepted (the engine returned no run id — poll automation_flow_status with the flowId)";
    return {
      summary: `Flow "${flowId}" triggered — ${runLine}.`,
      details: { accepted: result.accepted, flowId: result.flowId, runId: result.runId },
    };
  },
};

const automation_flow_status: ToolDef = {
  name: "automation_flow_status",
  description:
    "Read the status of an Activepieces flow run: terminal state (SUCCEEDED/FAILED/…), timing, and failure detail. Pass runId for a specific run or flowId for the newest run of a flow. Read-only.",
  kind: "safe",
  minRole: "viewer",
  argsSchema: {
    type: "object",
    properties: {
      runId: { type: "string", description: "Flow run id to poll (optional)." },
      flowId: { type: "string", description: "Flow id — reads the newest run (optional)." },
    },
  },
  async execute(ctx, args) {
    const runId = str(args.runId);
    const flowId = str(args.flowId);
    if (!runId && !flowId) throw new Error("runId or flowId is required");
    const { isActivepiecesConfigured, workspaceFlows } = await import("@/lib/integrations/activepieces");
    if (!isActivepiecesConfigured()) {
      throw new Error(
        "Activepieces is not connected: set ACTIVEPIECES_URL and ACTIVEPIECES_API_KEY on the host (Settings → Providers).",
      );
    }
    // Runs/flows outside this workspace read as not found (H6).
    const flows = workspaceFlows(ctx.workspaceId);
    const run = runId ? await flows.run(runId) : await flows.latestRun(flowId as string);
    if (!run) {
      return { summary: `No runs recorded for flow "${flowId}" yet.`, details: { run: null } };
    }
    const state = run.terminal ? (run.succeeded ? "SUCCEEDED" : run.status) : `${run.status} (still running)`;
    return {
      summary: `Run ${run.id}: ${state}${run.failure?.errorMessage ? ` — ${run.failure.errorMessage}` : ""}`,
      details: { run },
    };
  },
};

// Phase 4b (Dataset Builder slice 4 "Activate"): the OS RAG layer. Answers
// only from datasets the tenant published to RAG + Feed, with citations;
// refuses to guess when nothing matches.
const ask_business_data: ToolDef = {
  name: "ask_business_data",
  description:
    "Answer a question about the business (FAQs, products, policies, SOPs, company facts, pricing) strictly from the datasets this workspace published to RAG + Feed. Returns the best-matching passage plus Source → Document → Chunk citations; says so when nothing matches. Use it before answering factual questions about the tenant's own business.",
  kind: "safe",
  minRole: "viewer",
  argsSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question, in the user's words." },
    },
    required: ["question"],
  },
  async execute(ctx, args) {
    const question = str(args.question);
    if (!question) return { summary: "A question is required." };
    const store = new PrismaDatasetBuilderStore(prisma);
    const res = await askPublishedDatasets(store, ctx.workspaceId, question.slice(0, 2000));
    if (!res.grounded) return { summary: res.answer, details: { searched: res.searched } };
    const cites = res.citations
      .map((c) => `${c.datasetLabel} v${c.datasetVersion}: ${c.sourceName} → ${c.documentName}`)
      .join("; ");
    return {
      summary: `${res.answer.slice(0, 600)}${res.answer.length > 600 ? "…" : ""} (sources: ${cites})`,
      details: res,
    };
  },
};

export const TOOLS: ToolDef[] = [
  get_keywords,
  get_rankings,
  get_competitors,
  get_content,
  get_alerts,
  get_visibility_score,
  get_workflows,
  load_skill,
  research_keywords,
  create_content_draft,
  run_seo_audit,
  create_report,
  run_workflow,
  approve_autopilot_item,
  design_qr_code,
  trigger_automation_flow,
  automation_flow_status,
  // Wave 2 context.dev slice 3: research a question (spend-kind).
  research_question,
  // Phase 4b: grounded answers from published datasets.
  ask_business_data,
  // Phase 7: images from OpenAI's image model, saved as workspace files.
  generate_image,
  // Phase 17: business operations (invoices, inventory, POs, projects, HR,
  // workflows) — propose-only money writes.
  ...OPS_TOOLS,
];

export function getTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name) ?? EXTRA_TOOLS.get(name);
}

// ---------------------------------------------------------------------------
// Phase 5: tool groups + automation actions.
//
// Every tool belongs to exactly one group (what a task's grant is made of)
// and every non-safe tool names the automation action it stands for (what a
// per-agent auto-approve rule is keyed by; lib/automation/policy.ts). Kept
// as one table so a new tool can't silently skip either — the tools test
// asserts every registered tool has a group.
// ---------------------------------------------------------------------------

export const TOOL_GROUP: Readonly<Record<string, ToolGroup>> = {
  get_keywords: "workspace",
  get_rankings: "workspace",
  get_competitors: "workspace",
  get_content: "workspace",
  get_alerts: "workspace",
  get_visibility_score: "workspace",
  get_workflows: "workspace",
  load_skill: "workspace",
  ask_business_data: "workspace",
  automation_flow_status: "workspace",
  research_keywords: "web",
  research_question: "web",
  create_content_draft: "content",
  create_report: "content",
  design_qr_code: "content",
  generate_image: "media",
  run_seo_audit: "site",
  run_workflow: "automation",
  approve_autopilot_item: "automation",
  trigger_automation_flow: "automation",
  ops_operations_summary: "workspace",
  ops_list_invoices: "workspace",
  ops_list_products: "workspace",
  ops_list_purchase_orders: "workspace",
  ops_list_projects: "workspace",
  ops_list_team: "workspace",
  ops_list_workflow_runs: "workspace",
  ops_draft_invoice: "ops",
  ops_draft_purchase_order: "ops",
  ops_create_project: "ops",
  ops_request_leave: "ops",
  ops_send_invoice: "ops",
  ops_mark_invoice_paid: "ops",
  ops_approve_leave: "ops",
  ops_launch_workflow: "ops",
  delegate_to_subagent: "delegate",
  // Phase 8 (ship): local git work in the run's sandbox is "code"; anything
  // that leaves the sandbox is "ship" (lib/ship/tools.ts).
  git_clone: "code",
  git_status: "code",
  git_diff: "code",
  git_commit: "code",
  git_push_branch: "ship",
  open_pull_request: "ship",
  read_pr_feedback: "ship",
  // Phase 8: recorded browser tools (lib/agents/runs/browser-tools.ts).
  browser_open: "web",
  browser_extract: "web",
  browser_act: "web",
  // Phase 8: code tools, registered by lib/sandbox/tools.ts (run in the
  // agent run's sandbox, never on the host).
  read_file: "code",
  glob: "code",
  grep: "code",
  write_file: "code",
  edit_file: "code",
  bash: "code",
  run_tests: "code",
  // Phase 9 (apps): mini-app tools, registered by lib/apps/tools.ts. Reads
  // are workspace; writes are ops (same split as the ops tools).
  app_list_records: "workspace",
  app_create_spec: "ops",
  app_upsert_record: "ops",
  app_delete_record: "ops",
};

/**
 * The automation action each non-safe tool stands for. Tier-0 kinds (draft_,
 * audit_, report_, search_) may be switched to auto per agent; everything
 * else here evaluates Tier 2+ in lib/orchestrator/authority.ts and so always
 * asks, whatever a rule says.
 */
export const TOOL_ACTION: Readonly<Record<string, string>> = {
  research_keywords: "search_keywords",
  research_question: "search_web",
  create_content_draft: "draft_content",
  create_report: "report_generate",
  design_qr_code: "draft_qr_code",
  generate_image: "draft_image",
  run_seo_audit: "audit_site",
  run_workflow: "run_workflow",
  approve_autopilot_item: "approve_autopilot_item",
  trigger_automation_flow: "trigger_automation_flow",
  ops_draft_invoice: "draft_invoice",
  ops_draft_purchase_order: "draft_purchase_order",
  ops_create_project: "create_project",
  ops_request_leave: "request_leave",
  ops_send_invoice: "send_invoice",
  ops_mark_invoice_paid: "mark_invoice_paid",
  ops_approve_leave: "approve_leave",
  ops_launch_workflow: "launch_workflow",
  // Phase 8: Tier 2 — always asks (lib/automation/actions.ts).
  git_push_branch: "push_branch",
  open_pull_request: "open_pr",
  browser_act: "browser_act",
  // Phase 8: sandbox edits are Tier 0 (local to an isolated, checkpointed
  // sandbox — a per-agent auto rule may apply); commands are Tier 2 (ask).
  write_file: "edit_sandbox_files",
  edit_file: "edit_sandbox_files",
  bash: "run_sandbox_command",
  run_tests: "run_sandbox_command",
  // Phase 9 (apps): drafting a spec is Tier 0 (a draft; publishing is a
  // person's job); record writes are Tier 2 and deletes Tier 3 — both
  // always ask (lib/automation/actions.ts).
  app_create_spec: "draft_app_spec",
  app_upsert_record: "write_app_record",
  app_delete_record: "delete_app_record",
};

/** The group a tool belongs to. Unknown tools fall in "connectors" (fail closed). */
export function toolGroup(name: string): ToolGroup {
  return TOOL_GROUP[name] ?? "connectors";
}

/** The automation action a tool stands for (unknown = a Tier-2 kind that always asks). */
export function toolAction(name: string): string {
  return TOOL_ACTION[name] ?? `tool_${name}`;
}

/** Is this tool inside the task's grant? */
export function toolGranted(name: string, grant: readonly string[] | null | undefined): boolean {
  return isGroupGranted(grant, toolGroup(name));
}

/**
 * Tools registered at runtime by the agent loop (delegate_to_subagent lives
 * in lib/chat/agent.ts because it runs the loop itself). Same ToolDef
 * contract, same gates.
 */
const EXTRA_TOOLS = new Map<string, ToolDef>();

export function registerExtraTool(tool: ToolDef): void {
  EXTRA_TOOLS.set(tool.name, tool);
}

export function allTools(): ToolDef[] {
  return [...TOOLS, ...EXTRA_TOOLS.values()];
}

/**
 * One-line safety legend for the agent system prompt. Phase 5: with a grant,
 * only the tools inside it are listed — the model never sees the rest (and
 * executeTool refuses them anyway).
 */
export function toolCatalogForPrompt(grant?: readonly string[] | null): string {
  return allTools().filter((t) => toolGranted(t.name, grant)).map((t) => {
    const props = Object.entries(t.argsSchema.properties)
      .map(([k, v]) => `${k}: ${v.type}${t.argsSchema.required?.includes(k) ? " (required)" : ""} — ${v.description}`)
      .join("\n    ");
    return `- ${t.name} [${t.kind}, min role: ${t.minRole}]\n  ${t.description}\n  args:\n    ${props}`;
  }).join("\n");
}
