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
import type { SiteSourceType, WorkspaceRole } from "@prisma/client";
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
import { runAudit } from "@/lib/audit/audit";
import { getSiteIdeProvider, siteIsMock } from "@/lib/connectors/source";
import { generateReport } from "@/lib/pdf/generate";
import { approveAutopilotItem } from "@/lib/seo/autopilot-service";
import { designQr, printLockQr, QrDesignerError } from "@/lib/studio/qr-designer";
import { auditStudio } from "@/lib/studio/service";

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
}

export interface ToolResult {
  summary: string;
  details?: unknown;
}

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
    const CONTENT_ONLY: SiteSourceType[] = ["wordpress", "webflow"];
    let site = str(args.siteId)
      ? await prisma.site.findFirst({
          where: { id: str(args.siteId), projectId: ctx.projectId },
          include: { sftpConnection: true },
        })
      : await prisma.site.findFirst({
          where: { projectId: ctx.projectId, sourceType: { notIn: CONTENT_ONLY } },
          orderBy: { createdAt: "asc" },
          include: { sftpConnection: true },
        });
    if (!site) throw new Error("No auditable site found in this project");
    if (CONTENT_ONLY.includes(site.sourceType)) {
      throw new Error("Audits scan site files — this site is a content-level source with no file tree");
    }
    const useMock = siteIsMock(site as never);
    const provider = useMock ? null : await getSiteIdeProvider(site as never);
    const result = await runAudit({
      siteId: site.id,
      projectId: ctx.projectId,
      siteName: site.name,
      provider,
      mock: useMock,
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
];

export function getTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** One-line safety legend for the agent system prompt. */
export function toolCatalogForPrompt(): string {
  return TOOLS.map((t) => {
    const props = Object.entries(t.argsSchema.properties)
      .map(([k, v]) => `${k}: ${v.type}${t.argsSchema.required?.includes(k) ? " (required)" : ""} — ${v.description}`)
      .join("\n    ");
    return `- ${t.name} [${t.kind}, min role: ${t.minRole}]\n  ${t.description}\n  args:\n    ${props}`;
  }).join("\n");
}
