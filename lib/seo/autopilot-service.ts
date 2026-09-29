// Marketr — content autopilot orchestration (milestone 18).
//
// Rule engine: pull candidates from a configured source (M14 decay queue,
// M17 programmatic pages, keyword opportunities), generate drafts via the M4
// content engine, and enqueue them for human approval. Server-side approval
// gates, kill switch, and full audit trail. Pure logic lives in ./autopilot.ts.

import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getLlmProviderFor } from "@/lib/llm";
import { buildDraftPrompt } from "@/lib/content/draft";
import {
  capCandidates,
  dedupeCandidates,
  fallbackTitle,
  isAutoApproveEligible,
  markdownToTiptap,
  scopeKeyFor,
  validateRuleInput,
  type AutopilotCandidate,
  type AutopilotItemKind,
  type RuleInput,
} from "./autopilot";
import { pushProgrammaticPages, buildSiteHtml, siteFilePathForUrl } from "./programmatic-publish";
import { emitAlert } from "@/lib/alerts/evaluate";
import { meter } from "@/lib/metering/service";
import { getSiteIdeProvider, ownedSite } from "@/lib/connectors/source";
import { sanitizePath } from "@/lib/sitefiles/paths";

type Db = PrismaClient;

type AuditAction =
  | "autopilot_rule_created"
  | "autopilot_rule_updated"
  | "autopilot_rule_deleted"
  | "autopilot_run_started"
  | "autopilot_run_finished"
  | "autopilot_item_generated"
  | "autopilot_item_approved"
  | "autopilot_item_rejected"
  | "autopilot_item_published"
  | "autopilot_item_edited"
  | "autopilot_killed"
  | "autopilot_unkilled";

/** Shared audit helper for the autopilot API routes. */
export async function auditAutopilot(
  db: Db,
  workspaceId: string,
  projectId: string,
  action: AuditAction,
  summary: string,
  actor: "user" | "system" = "user",
): Promise<void> {
  await db.fileChangeLog.create({
    data: {
      workspaceId,
      projectId,
      connectionId: null,
      filePath: "",
      actor,
      action,
      summary: summary.slice(0, 280),
    },
  });
}

// Draft generation
// ---------------------------------------------------------------------------

export interface GeneratedDraft {
  title: string;
  markdown: string;
}

/** Generates an AI draft for one candidate. Swappable for tests. */
export type DraftGenerator = (candidate: AutopilotCandidate) => Promise<GeneratedDraft>;

/** Default draft generator: M4 content-engine prompt → swappable LLM provider. */
export const defaultDraftGenerator: DraftGenerator = async (candidate) => {
  // Phase D: autopilot drafts are client-facing articles → "copy" workload.
  const llm = getLlmProviderFor("copy");
  const prompt = buildDraftPrompt({
    keyword: candidate.brief,
    intent: "informational",
    h1: candidate.title,
    h2s: [],
    paa: [],
    targetWordCount: 1200,
    entities: [],
    sources: [],
    mock: true,
  });
  const markdown = await llm.generate(prompt);
  return { title: candidate.title, markdown };
};

// Rules
// ---------------------------------------------------------------------------

export async function createAutopilotRule(
  db: Db,
  args: { workspaceId: string; projectId: string; input: RuleInput },
): Promise<{ id: string }> {
  const v = validateRuleInput(args.input);
  const rule = await db.autopilotRule.create({
    data: {
      projectId: args.projectId,
      name: v.name,
      source: v.source,
      programmaticTemplateId: v.programmaticTemplateId,
      cadence: v.cadence,
      maxItemsPerRun: v.maxItemsPerRun,
      autoApprove: v.autoApprove,
      publishTarget: (v.publishTarget ?? undefined) as never,
      enabled: v.enabled,
    },
  });
  await auditAutopilot(db, args.workspaceId, args.projectId, "autopilot_rule_created",
    `Autopilot rule created: "${v.name}" (${v.source}, ${v.cadence}, max ${v.maxItemsPerRun}/run)`);
  return { id: rule.id };
}

export async function updateAutopilotRule(
  db: Db,
  args: { workspaceId: string; projectId: string; ruleId: string; input: Partial<RuleInput> },
): Promise<void> {
  const existing = await db.autopilotRule.findFirst({
    where: { id: args.ruleId, projectId: args.projectId },
  });
  if (!existing) throw new Error("Autopilot rule not found");
  const merged: RuleInput = {
    name: args.input.name ?? existing.name,
    source: args.input.source ?? existing.source,
    programmaticTemplateId: args.input.programmaticTemplateId ?? existing.programmaticTemplateId,
    cadence: args.input.cadence ?? existing.cadence,
    maxItemsPerRun: args.input.maxItemsPerRun ?? existing.maxItemsPerRun,
    autoApprove: args.input.autoApprove ?? existing.autoApprove,
    publishTarget: args.input.publishTarget ?? (existing.publishTarget as never),
    enabled: args.input.enabled ?? existing.enabled,
  };
  const v = validateRuleInput(merged);
  await db.autopilotRule.update({
    where: { id: args.ruleId },
    data: {
      name: v.name,
      source: v.source,
      programmaticTemplateId: v.programmaticTemplateId,
      cadence: v.cadence,
      maxItemsPerRun: v.maxItemsPerRun,
      autoApprove: v.autoApprove,
      publishTarget: (v.publishTarget ?? undefined) as never,
      enabled: v.enabled,
    },
  });
  await auditAutopilot(db, args.workspaceId, args.projectId, "autopilot_rule_updated",
    `Autopilot rule updated: "${v.name}"`);
}

export async function deleteAutopilotRule(
  db: Db,
  args: { workspaceId: string; projectId: string; ruleId: string },
): Promise<void> {
  const existing = await db.autopilotRule.findFirst({
    where: { id: args.ruleId, projectId: args.projectId },
    select: { id: true, name: true },
  });
  if (!existing) throw new Error("Autopilot rule not found");
  await db.autopilotRule.delete({ where: { id: args.ruleId } });
  await auditAutopilot(db, args.workspaceId, args.projectId, "autopilot_rule_deleted",
    `Autopilot rule deleted: "${existing.name}"`);
}

// Kill switch
// ---------------------------------------------------------------------------

export async function getKillStatus(
  db: Db,
  args: { workspaceId: string; projectId: string },
): Promise<{ workspaceKilled: boolean; projectKilled: boolean; killed: boolean }> {
  const rows = await db.autopilotKillSwitch.findMany({
    where: { scopeKey: { in: [scopeKeyFor({ workspaceId: args.workspaceId }), scopeKeyFor({ projectId: args.projectId })] } },
  });
  const workspaceKilled = rows.some((r) => r.scopeKey === `workspace:${args.workspaceId}` && r.killed);
  const projectKilled = rows.some((r) => r.scopeKey === `project:${args.projectId}` && r.killed);
  return { workspaceKilled, projectKilled, killed: workspaceKilled || projectKilled };
}

/**
 * True when autopilot must not run/publish for this project.
 *
 * Day-1 fix (critical #1): this used to query
 * `where: { workspaceId, OR: [{ projectId }] }`, which Prisma ANDs — kill rows
 * set exactly one of the two IDs (the other is NULL), so the query never
 * matched and runs continued while the UI reported "engaged". It now uses the
 * exact same scopeKey query as getKillStatus(), so the run check and the UI
 * can never disagree again.
 */
export async function isAutopilotKilled(db: Db, workspaceId: string, projectId: string): Promise<boolean> {
  const { killed } = await getKillStatus(db, { workspaceId, projectId });
  return killed;
}

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

async function alertAutopilotKilled(args: {
  workspaceId: string;
  projectId?: string | null;
  scope: string;
  reason?: string | null;
}): Promise<void> {
  try {
    await emitAlert({
      workspaceId: args.workspaceId,
      projectId: args.projectId ?? null,
      trigger: "autopilot_killed",
      severity: "critical",
      title: `🛑 Autopilot kill switch engaged (${args.scope})`,
      body: args.reason ? `Reason: ${args.reason}` : "All scheduled autopilot runs stopped immediately.",
      link: args.projectId ? `/dashboard/projects/${args.projectId}/autopilot` : undefined,
      dedupKey: `autopilot_killed:${args.scope}:${dayKey()}`,
    });
  } catch {
    // alert failures never break the kill
  }
}

/**
 * Engage the kill switch: running runs → killed, pending/approved items →
 * frozen (killed). Audit-logged + M13 alert. Re-enabling requires an explicit
 * un-kill — there is no silent resume.
 */
export async function killAutopilot(
  db: Db,
  args: {
    workspaceId: string;
    projectId?: string | null;
    actor: string;
    reason?: string | null;
  },
): Promise<void> {
  const projectId = args.projectId ?? null;
  const scopeKey = projectId ? scopeKeyFor({ projectId }) : scopeKeyFor({ workspaceId: args.workspaceId });
  const scopeLabel = projectId ? `project ${projectId}` : `workspace ${args.workspaceId}`;

  await db.autopilotKillSwitch.upsert({
    where: { scopeKey },
    update: { killed: true, killedAt: new Date(), killedBy: args.actor, reason: args.reason ?? null },
    create: {
      workspaceId: projectId ? null : args.workspaceId,
      projectId,
      scopeKey,
      killed: true,
      killedAt: new Date(),
      killedBy: args.actor,
      reason: args.reason ?? null,
    },
  });

  // Freeze running runs and in-flight items within scope.
  const ruleWhere = projectId ? { projectId } : { project: { workspaceId: args.workspaceId } };
  const runs = await db.autopilotRun.updateMany({
    where: { ...ruleWhere, status: "running" },
    data: { status: "killed", finishedAt: new Date(), error: "Killed by kill switch" },
  });
  const items = await db.autopilotItem.updateMany({
    where: { ...ruleWhere, status: { in: ["pending", "approved"] } },
    data: { status: "killed" },
  });

  await auditAutopilot(
    db,
    args.workspaceId,
    projectId ?? "",
    "autopilot_killed",
    `Autopilot kill switch engaged for ${scopeLabel}: ${runs.count} run(s) killed, ${items.count} item(s) frozen${args.reason ? ` — ${args.reason}` : ""}`,
    "user",
  );
  await alertAutopilotKilled({ workspaceId: args.workspaceId, projectId, scope: scopeLabel, reason: args.reason });
}

/** Explicit un-kill. Does not resume anything — runs must be started again. */
export async function unkillAutopilot(
  db: Db,
  args: { workspaceId: string; projectId?: string | null; actor: string },
): Promise<void> {
  const projectId = args.projectId ?? null;
  const scopeKey = projectId ? scopeKeyFor({ projectId }) : scopeKeyFor({ workspaceId: args.workspaceId });
  const scopeLabel = projectId ? `project ${projectId}` : `workspace ${args.workspaceId}`;
  await db.autopilotKillSwitch.upsert({
    where: { scopeKey },
    update: { killed: false },
    create: {
      workspaceId: projectId ? null : args.workspaceId,
      projectId,
      scopeKey,
      killed: false,
    },
  });
  await auditAutopilot(db, args.workspaceId, projectId ?? "", "autopilot_unkilled",
    `Autopilot kill switch released for ${scopeLabel} (no silent resume — rules must be run again)`, "user");
}

// Candidate selection
// ---------------------------------------------------------------------------

async function selectCandidates(
  db: Db,
  rule: {
    id: string;
    projectId: string;
    source: string;
    programmaticTemplateId: string | null;
    maxItemsPerRun: number;
  },
): Promise<AutopilotCandidate[]> {
  const { projectId } = rule;
  if (rule.source === "decay_refresh") {
    const findings = await db.contentDecayFinding.findMany({
      where: { projectId, status: "open", suggestedAction: "refresh_content" },
      orderBy: { decayScore: "desc" },
      take: 100,
      select: { id: true, url: true, phrases: true, decayScore: true, keywordId: true },
    });
    return findings.map((f, i) => ({
      kind: "decay_refresh" as const,
      sourceRef: f.id,
      title: f.phrases[0] ? `Refresh: ${f.phrases[0]}` : `Refresh content${f.url ? ` — ${f.url}` : ""}`,
      priority: i,
      brief: [
        `Refresh the content at ${f.url ?? "(unknown URL)"}.`,
        f.phrases.length ? `Decayed phrases: ${f.phrases.join(", ")}.` : "",
        `Decay score ${Math.round(f.decayScore)}/100. Rewrite the page to be more comprehensive, current, and helpful.`,
      ].filter(Boolean).join("\n"),
    }));
  }
  if (rule.source === "programmatic_template") {
    if (!rule.programmaticTemplateId) return [];
    const pages = await db.programmaticPage.findMany({
      where: { projectId, templateId: rule.programmaticTemplateId, status: "ready" },
      orderBy: { updatedAt: "desc" },
      take: 100,
      select: { id: true, url: true, content: true },
    });
    return pages.map((p, i) => {
      const c = (p.content ?? {}) as { title?: string; description?: string };
      return {
        kind: "programmatic_page" as const,
        sourceRef: p.id,
        title: c.title || fallbackTitle("programmatic_page", p.id),
        priority: i,
        brief: `Generate the final AI-written article for the programmatic page at ${p.url}. ${c.description ?? ""}`,
      };
    });
  }
  // keyword_opportunity: tracked keywords with no content item yet.
  const keywords = await db.keyword.findMany({
    where: {
      projectId,
      contentItems: { none: {} },
    },
    orderBy: [{ volume: "desc" }],
    take: 100,
    select: { id: true, phrase: true, volume: true },
  });
  return keywords.map((k, i) => ({
    kind: "keyword_brief" as const,
    sourceRef: k.id,
    title: k.phrase,
    priority: i,
    brief: `Write a new article targeting the keyword "${k.phrase}".`,
  }));
}

// Runs
// ---------------------------------------------------------------------------

export interface RunResult {
  runId: string;
  generated: number;
  autoApproved: number;
  skippedInFlight: number;
}

export async function runAutopilotRule(
  db: Db,
  args: {
    workspaceId: string;
    projectId: string;
    ruleId: string;
    actor: string;
    draftGenerator?: DraftGenerator;
  },
): Promise<RunResult> {
  const generate = args.draftGenerator ?? defaultDraftGenerator;
  const rule = await db.autopilotRule.findFirst({
    where: { id: args.ruleId, projectId: args.projectId },
  });
  if (!rule) throw new Error("Autopilot rule not found");
  if (!rule.enabled) throw new Error("Autopilot rule is disabled");
  if (await isAutopilotKilled(db, args.workspaceId, args.projectId)) {
    throw new Error("Autopilot is killed — release the kill switch before running");
  }

  const run = await db.autopilotRun.create({
    data: { ruleId: rule.id, projectId: args.projectId, status: "running", createdBy: args.actor },
  });
  await auditAutopilot(db, args.workspaceId, args.projectId, "autopilot_run_started",
    `Autopilot run started for rule "${rule.name}" (${rule.source})`, "system");

  try {
    const raw = await selectCandidates(db, {
      id: rule.id,
      projectId: args.projectId,
      source: rule.source,
      programmaticTemplateId: rule.programmaticTemplateId,
      maxItemsPerRun: rule.maxItemsPerRun,
    });
    const inFlight = await db.autopilotItem.findMany({
      where: { ruleId: rule.id, status: { in: ["pending", "approved"] } },
      select: { kind: true, sourceRef: true, status: true },
    });
    const before = raw.length;
    const candidates = capCandidates(
      dedupeCandidates(raw, inFlight.map((i) => ({ kind: i.kind as AutopilotItemKind, sourceRef: i.sourceRef, status: i.status as never }))),
      rule.maxItemsPerRun,
    );
    const skippedInFlight = before - candidates.length;

    let generated = 0;
    let autoApproved = 0;
    for (const c of candidates) {
      // Re-check the kill switch inside the loop — a kill during a run
      // freezes remaining items immediately.
      if (await isAutopilotKilled(db, args.workspaceId, args.projectId)) {
        throw new Error("Autopilot killed mid-run — remaining items frozen");
      }
      const draft = await generate(c);
      const eligible = isAutoApproveEligible(c.kind, rule.autoApprove);
      const item = await db.autopilotItem.create({
        data: {
          runId: run.id,
          ruleId: rule.id,
          projectId: args.projectId,
          kind: c.kind,
          sourceRef: c.sourceRef,
          title: (draft.title || c.title).slice(0, 200),
          draftJson: markdownToTiptap(draft.markdown) as never,
          draftMarkdown: draft.markdown,
          status: eligible ? "approved" : "pending",
          autoApproved: eligible,
        },
      });
      await auditAutopilot(db, args.workspaceId, args.projectId, "autopilot_item_generated",
        `Autopilot item generated: "${item.title}" (${c.kind})`, "system");
      // Phase C gaps (G1): ledger one content_refresh per decay-refresh
      // draft. The autopilotItem row is the domain row. Programmatic pages
      // are a separate flow with no credit-table action — left unwired.
      if (c.kind === "decay_refresh") {
        await meter({
          workspaceId: args.workspaceId,
          projectId: args.projectId,
          action: "content_refresh",
          idempotencyKey: `contentrefresh:${item.id}`,
          evidenceRef: `autopilot-item:${item.id}`,
        }).catch((err) => {
          console.error(`Metering failed for autopilot item ${item.id}:`, err);
        });
      }
      if (eligible) {
        autoApproved += 1;
        await auditAutopilot(db, args.workspaceId, args.projectId, "autopilot_item_approved",
          `Autopilot item auto-approved (low-risk decay refresh, rule "${rule.name}" allows it): "${item.title}"`, "system");
      }
      generated += 1;
    }

    await db.autopilotRun.update({
      where: { id: run.id },
      data: { status: "completed", finishedAt: new Date(), itemsGenerated: generated, itemsApproved: autoApproved },
    });
    await db.autopilotRule.update({ where: { id: rule.id }, data: { lastRunAt: new Date() } });
    await auditAutopilot(db, args.workspaceId, args.projectId, "autopilot_run_finished",
      `Autopilot run finished for rule "${rule.name}": ${generated} generated, ${autoApproved} auto-approved, ${skippedInFlight} skipped (already in flight)`, "system");
    return { runId: run.id, generated, autoApproved, skippedInFlight };
  } catch (err) {
    const killed = err instanceof Error && /killed/i.test(err.message);
    await db.autopilotRun.update({
      where: { id: run.id },
      data: {
        status: killed ? "killed" : "failed",
        finishedAt: new Date(),
        error: err instanceof Error ? err.message.slice(0, 500) : "Unknown error",
      },
    });
    await auditAutopilot(db, args.workspaceId, args.projectId, "autopilot_run_finished",
      `Autopilot run ${killed ? "killed" : "failed"} for rule "${rule.name}": ${err instanceof Error ? err.message : "unknown"}` , "system");
    if (!killed) {
      try {
        await emitAlert({
          workspaceId: args.workspaceId,
          projectId: args.projectId,
          trigger: "autopilot_run_failed",
          severity: "warn",
          title: `⚠️ Autopilot run failed: ${rule.name}`,
          body: err instanceof Error ? err.message : "Unknown error",
          link: `/dashboard/projects/${args.projectId}/autopilot`,
          dedupKey: `autopilot_run_failed:${rule.id}:${dayKey()}`,
        });
      } catch { /* alert failures never break the run */ }
    }
    throw err;
  }
}

// Approval gates
// ---------------------------------------------------------------------------

/**
 * Parse a workflow approval-gate sourceRef ("workflow_run:<runId>:<nodeId>").
 * Local helper (not imported from lib/workflow/approvals) so this module
 * keeps no static dependency on the workflow engine.
 */
function parseWorkflowGateRef(sourceRef: string): { runId: string; nodeId: string } | null {
  const m = /^workflow_run:([^:]+):([^:]+)$/.exec(sourceRef);
  return m ? { runId: m[1], nodeId: m[2] } : null;
}

async function loadItem(db: Db, projectId: string, itemId: string) {
  const item = await db.autopilotItem.findFirst({
    where: { id: itemId, projectId },
    include: { rule: true },
  });
  if (!item) throw new Error("Autopilot item not found");
  return item;
}

export async function approveAutopilotItem(
  db: Db,
  args: { workspaceId: string; projectId: string; itemId: string; actor: string },
): Promise<void> {
  const item = await loadItem(db, args.projectId, args.itemId);
  if (item.status !== "pending") throw new Error(`Item cannot be approved from status "${item.status}"`);
  if (await isAutopilotKilled(db, args.workspaceId, args.projectId)) {
    throw new Error("Autopilot is killed — release the kill switch before approving");
  }
  await db.autopilotItem.update({ where: { id: item.id }, data: { status: "approved" } });
  await auditAutopilot(db, args.workspaceId, args.projectId, "autopilot_item_approved",
    `Autopilot item approved: "${item.title}"`);
  // Redesign §2 (automation canvas): workflow approval gates enqueue items
  // with sourceRef "workflow_run:<runId>:<nodeId>". Approving one resumes
  // the paused workflow run. Dynamic import avoids a static import cycle
  // with lib/workflow/engine (engine → actions → this module).
  const gate = parseWorkflowGateRef(item.sourceRef);
  if (gate) {
    try {
      const { resumeWorkflowRun } = await import("@/lib/workflow/engine");
      await resumeWorkflowRun({
        runId: gate.runId,
        nodeId: gate.nodeId,
        decision: "approved",
        itemId: item.id,
        workspaceId: args.workspaceId,
        actor: args.actor,
      });
    } catch (err) {
      await auditAutopilot(db, args.workspaceId, args.projectId, "autopilot_run_finished",
        `Workflow run ${gate.runId} failed to resume after approval: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export async function rejectAutopilotItem(
  db: Db,
  args: { workspaceId: string; projectId: string; itemId: string; actor: string; note?: string },
): Promise<void> {
  const item = await loadItem(db, args.projectId, args.itemId);
  if (item.status !== "pending" && item.status !== "approved") {
    throw new Error(`Item cannot be rejected from status "${item.status}"`);
  }
  await db.autopilotItem.update({
    where: { id: item.id },
    data: { status: "rejected", reviewNote: args.note?.slice(0, 500) ?? null },
  });
  await auditAutopilot(db, args.workspaceId, args.projectId, "autopilot_item_rejected",
    `Autopilot item rejected: "${item.title}"${args.note ? ` — ${args.note}` : ""}`);
  // Redesign §2 (automation canvas): rejecting a workflow gate item cancels
  // the paused run. Mirrors the approval hook above (dynamic import avoids
  // the static cycle with lib/workflow/engine).
  const gate = parseWorkflowGateRef(item.sourceRef);
  if (gate) {
    try {
      const { resumeWorkflowRun } = await import("@/lib/workflow/engine");
      await resumeWorkflowRun({
        runId: gate.runId,
        nodeId: gate.nodeId,
        decision: "rejected",
        itemId: item.id,
        workspaceId: args.workspaceId,
        actor: args.actor,
      });
    } catch (err) {
      await auditAutopilot(db, args.workspaceId, args.projectId, "autopilot_run_finished",
        `Workflow run ${gate.runId} failed to cancel after rejection: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// Publishing
// ---------------------------------------------------------------------------

/**
 * Edit a pending item's editable fields (title, draftMarkdown) and keep it
 * pending (requeue). Phase 16 generative approval card semantics: edit is
 * update-then-requeue-pending — the item stays in the approval queue and
 * must still be approved before it can publish. Audit-logged like every
 * other gate decision.
 */
export async function editAutopilotItem(
  db: Db,
  args: {
    workspaceId: string;
    projectId: string;
    itemId: string;
    actor: string;
    title?: string;
    draftMarkdown?: string | null;
  },
): Promise<void> {
  const item = await loadItem(db, args.projectId, args.itemId);
  if (item.status !== "pending") throw new Error(`Item cannot be edited from status "${item.status}"`);
  const title = args.title?.trim();
  const draftMarkdown = args.draftMarkdown?.trim();
  if (!title && !draftMarkdown) throw new Error("Edit requires a new title and/or draft markdown");
  await db.autopilotItem.update({
    where: { id: item.id },
    data: {
      ...(title ? { title: title.slice(0, 300) } : {}),
      ...(draftMarkdown ? { draftMarkdown: draftMarkdown.slice(0, 100_000) } : {}),
      status: "pending",
    },
  });
  const changed = [
    title ? "title" : null,
    draftMarkdown ? "draft" : null,
  ].filter(Boolean).join(" + ");
  await auditAutopilot(db, args.workspaceId, args.projectId, "autopilot_item_edited",
    `Autopilot item edited (${changed}): "${item.title}"`);
}

/**
 * Publish an approved item. programmatic_page items go through the existing
 * M17 push-publish path (same gates, same idempotency). decay_refresh and
 * keyword_brief items refresh the underlying page via the M6/M7 site-IDE
 * working copy — the appropriate existing path for non-programmatic pages.
 */
export async function publishAutopilotItem(
  db: Db,
  args: { workspaceId: string; projectId: string; itemId: string; actor: string; userId: string },
): Promise<{ publishedUrl: string | null }> {
  const item = await loadItem(db, args.projectId, args.itemId);
  if (item.status !== "approved") throw new Error(`Item must be approved before publishing (status: "${item.status}")`);
  if (await isAutopilotKilled(db, args.workspaceId, args.projectId)) {
    throw new Error("Autopilot is killed — release the kill switch before publishing");
  }

  let publishedUrl: string | null = null;

  if (item.kind === "programmatic_page") {
    const ruleTarget = (item.rule.publishTarget ?? null) as { kind?: string; siteId?: string | null; collectionId?: string | null } | null;
    const res = await pushProgrammaticPages({
      userId: args.userId,
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      pageIds: [item.sourceRef],
      actor: "user",
      explicitDest: ruleTarget?.kind
        ? { target: ruleTarget.kind, siteId: ruleTarget.siteId ?? undefined, collectionId: (ruleTarget as { webflowCollectionId?: string }).webflowCollectionId ?? ruleTarget.collectionId ?? undefined }
        : undefined,
    });
    const push = res.pushes[0];
    if (!push) {
      const reason = res.blocked[0]?.reasons.join("; ") ?? "unknown";
      throw new Error(`Publish blocked: ${reason}`);
    }
    publishedUrl = push.externalUrl ?? push.url;
  } else {
    // Non-programmatic items: write the refreshed page into the project's
    // Marketr-site IDE working copy (M6/M7 path).
    const ruleTarget = (item.rule.publishTarget ?? null) as { kind?: string; siteId?: string | null } | null;
    let siteId = ruleTarget?.kind === "marketr-site" ? (ruleTarget.siteId ?? null) : null;
    let site = siteId ? await ownedSite(args.userId, args.projectId, siteId) : null;
    if (!site) {
      const first = await db.site.findFirst({ where: { projectId: args.projectId }, orderBy: { createdAt: "asc" }, select: { id: true } });
      site = first ? await ownedSite(args.userId, args.projectId, first.id) : null;
    }
    if (!site) throw new Error("No site available — connect a Marketr site to publish autopilot refreshes");
    const url = item.kind === "decay_refresh"
      ? ((await db.contentDecayFinding.findFirst({ where: { id: item.sourceRef }, select: { url: true } }))?.url ?? "/")
      : `/${item.sourceRef}`;
    const bodyHtml = item.draftMarkdown
      ? `<article>\n${item.draftMarkdown.split("\n").filter((l) => l.trim()).map((l) => `<p>${escapeHtml(l.trim())}</p>`).join("\n")}\n</article>`
      : "";
    const html = buildSiteHtml({ title: item.title, description: "", canonical: null, noindex: false, bodyHtml });
    const provider = await getSiteIdeProvider(site);
    const safe = sanitizePath(siteFilePathForUrl(url));
    await provider.writeFile(safe, html);
    publishedUrl = url;
  }

  await db.autopilotItem.update({
    where: { id: item.id },
    data: { status: "published", publishedUrl, publishedAt: new Date() },
  });
  await db.autopilotRun.update({
    where: { id: item.runId },
    data: { itemsPublished: { increment: 1 } },
  });
  await auditAutopilot(db, args.workspaceId, args.projectId, "autopilot_item_published",
    `Autopilot item published: "${item.title}"${publishedUrl ? ` → ${publishedUrl}` : ""}`);
  return { publishedUrl };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
