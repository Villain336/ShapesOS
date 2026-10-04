// Marketr — AI chat agent loop (redesign §3a).
//
// Prompt-engineered tool-calling over the tool catalog in ./tools:
//   1. Build project context (domain, keywords, rankings, alerts, reports, workflows).
//   2. Ask the model to reply EITHER with plain text OR a single JSON block:
//        {"tool_calls":[{"tool":"...","args":{...}}]}
//   3. Parse defensively, execute allowlisted tools, feed results back,
//      loop at most 6 iterations, then produce the final answer.
//   4. Persist every turn as AiChatMessage rows (user / assistant / tool).
//
// CONFIRMATION GATE: destructive/publish/spend tools NEVER execute from a
// single message. The assistant first proposes the action and asks for
// confirmation; the proposal is stored in the assistant message's toolCalls
// JSON with status "pending_confirmation". Only when the next user message
// matches /^(yes|confirm|do it|go ahead|approved)/i does the tool execute —
// with the confirmation recorded in the audit log.
//
// MOCK MODE: when llmStatus() shows no live provider, a deterministic
// rule-based router handles slash commands so the page is fully demonstrable.
//
// PHASE 5 — the four agent controls, enforced here on the server:
//   * Hand a task to one sub-agent: a thread carries its agent (lead or a
//     sub-agent) and every turn runs AS that agent (its role prompt, its
//     tools); the lead can hand work off with delegate_to_subagent, which
//     runs the sub-agent as a child AgentRun (parentRunId).
//   * Limit a task's tools: the thread's grant (lib/agents/grants.ts) filters
//     the catalog the model sees AND executeTool / resolveConnectorTool
//     refuse anything outside it (status "denied", audited). A child's grant
//     is always inside its parent's.
//   * Stop: runTrackedAgentTurn records each turn as an AgentRun; the loop
//     checks for a stop before every model call and every tool call, aborts
//     an in-flight model call, cancels the turn's pending proposals and
//     expires the approvals it raised.
//   * Auto-approve: a per-agent rule (lib/automation/policy.ts) may let a
//     Tier 0/1 action run without the "yes" — Tier 2/3 and destructive tools
//     always ask, whatever the rule says.

import { prisma } from "@/lib/prisma";
import type { WorkspaceRole } from "@prisma/client";
import { roleAtLeast } from "@/lib/authz";
import { getLlmProviderFor, llmStatus } from "@/lib/llm";
import {
  allTools,
  getTool,
  registerExtraTool,
  TOOL_RECORDED_EVENT,
  toolAction,
  toolCatalogForPrompt,
  toolGranted,
  toolGroup,
  type ToolContext,
  type ToolDef,
  type ToolResult,
} from "./tools";
import {
  AGENT_MAX_GROUPS,
  TOOL_GROUP_LABELS,
  agentDisplayName,
  computeGrant,
  isAgentKey,
  type AgentKey,
  type ToolGroup,
} from "@/lib/agents/grants";
import { subAgentSystemPrompt } from "@/lib/agents/roles";
import { autoApprovalFor } from "@/lib/automation/policy";
import {
  appendAgentRunEvent,
  createAgentRun,
  finishAgentRun,
  isAgentRunCancelRequested,
  markAgentRunRunning,
} from "@/lib/agents/runs/service";
import { abortRun, isRunStopped, registerRunAbort, releaseRunAbort, RunStoppedError } from "@/lib/agents/runs/abort";
import { expireApprovalsForStoppedRun } from "@/lib/integrations/actions/gate";
import { getEnabledProjectSkills } from "@/lib/skills/service";
import { skillManifestSection } from "@/lib/skills/disclosure";
import { connectorToolsSection, resolveConnectorTool } from "./connector-tools";
import { captureEpisode } from "@/lib/agents/learning/capture";
// Phase 8: ship tools (git in the sandbox → push → PR) and recorded browser
// tools register themselves with the tool registry on import.
import "@/lib/ship/tools";
import "@/lib/agents/runs/browser-tools";
// Phase 10 M9: Expert Constitution Pack v1 — the Chief Strategy Agent's
// system-prompt layer (global hard rules + CSA constitution), wired in
// front of all project context and retrieval grounding.
import { constitutionSystemPrompt } from "@/lib/expert/constitution";
// Phase 13B: company-intelligence prompt injection (style rules → voice →
// knowledge → lessons/preferences → episodes) + fail-closed style-rule
// enforcement on the delivery path.
import { buildIntelligenceContext } from "@/lib/intelligence/company/prompt-context";
import {
  enforceStyleRules,
  StyleRuleBlockedError,
} from "@/lib/intelligence/enforce";
// Phase 12: Agency-Agents persona seeds (MIT, original distillations) as
// selectable advisor personas for the Chief Strategy Agent.
import {
  assertPersonaForSurface,
  PERSONAS,
  personaSystemPrompt,
  personaSystemPromptFor,
  personasForSurface,
  type PersonaId,
} from "@/lib/expert/personas";

const MAX_ITERATIONS = 6;

/**
 * Phase 12: selectable advisor personas for the Chief Strategy Agent.
 * Business Strategist + Agents Orchestrator sharpen the CSA's mandatory
 * reasoning order with a consulting lens (tradeoffs, assumptions, moat)
 * and an orchestration lens (phase gates, evidence, escalation).
 * advisorSystemPrompt(personaId) composes the persona's seed BEHIND the
 * global hard rules — the same layering contract as the CSA constitution.
 * A UI advisor picker or future prompt-layer selection should offer
 * exactly these ids, sourced from personasForSurface("csa").
 */
export const CSA_ADVISOR_PERSONAS: readonly PersonaId[] =
  personasForSurface("csa");

export function advisorSystemPrompt(persona: PersonaId): string {
  assertPersonaForSurface(persona, "csa");
  return [
    personaSystemPrompt(persona),
    `<!-- advisor provenance: ${PERSONAS[persona].provenance.repo} (${PERSONAS[persona].provenance.license}), ${PERSONAS[persona].provenance.sourceFile} -->`,
  ].join("\n\n");
}

/**
 * Phase 13B: workspace-aware variant — layers the PersonaProfile voice
 * block (user override if one exists, built-in default otherwise) behind
 * the hard rules and the seed. Any live CSA call MUST use this instead of
 * advisorSystemPrompt().
 */
export async function advisorSystemPromptFor(
  workspaceId: string,
  persona: PersonaId,
): Promise<string> {
  assertPersonaForSurface(persona, "csa");
  return [
    await personaSystemPromptFor(persona, workspaceId),
    `<!-- advisor provenance: ${PERSONAS[persona].provenance.repo} (${PERSONAS[persona].provenance.license}), ${PERSONAS[persona].provenance.sourceFile} -->`,
  ].join("\n\n");
}

export interface ChatToolCall {
  tool: string;
  args: Record<string, unknown>;
  resultSummary?: string;
  /**
   * Phase 5 adds "denied" (outside the task's tool grant) and "cancelled"
   * (the run was stopped before it ran, or a pending proposal was dropped).
   */
  status: "executed" | "pending_confirmation" | "error" | "skipped_role" | "denied" | "cancelled";
  confirmed?: boolean;
  /** Phase 5: the agent that made the call (absent = the thread's agent). */
  agentKey?: string;
  /** Phase 5: the grant the call was proposed under (re-checked on "yes"). */
  grant?: string[];
  /** Phase 5: set when a per-agent rule let it run without asking. */
  autoApproved?: string;
  /**
   * Phase 5: on a pending proposal, the automation action a per-agent rule
   * could cover (Tier 0/1 only) — the chat offers "do this without asking".
   * Absent = this kind of action always asks.
   */
  autoAction?: string;
  /** Phase 5: calls a sub-agent made inside a delegate_to_subagent call. */
  delegated?: ChatToolCall[];
}

const CONFIRM_RE = /^(yes|confirm|do it|go ahead|approved)(\b|[.!].*)$/i;

export const SLASH_HELP = [
  "Slash commands (work even in mock mode):",
  "  /keywords            — list saved keywords",
  "  /rankings            — rankings summary + visibility score",
  "  /alerts              — open alerts + issues",
  "  /competitors         — tracked competitors + radar events",
  "  /draft <topic>       — create a content draft (asks to confirm first)",
  "  /audit [siteId]      — run an SEO audit (asks to confirm first)",
  "  /report [templateId] — generate a branded report (asks to confirm first)",
  "  /workflow <id|name>  — trigger a workflow run (asks to confirm first)",
  "  /approve <itemId>    — approve a pending autopilot item (asks to confirm first)",
  "  /help                — this list",
  "",
  "Write tools always ask for confirmation before they run — reply \"yes\" to proceed.",
].join("\n");

// ---------------------------------------------------------------------------
// Project context
// ---------------------------------------------------------------------------

async function buildProjectContext(projectId: string, workspaceId: string): Promise<string> {
  const [project, keywordCount, trackedCount, topKeywords, openIssues, recentReports, workflows] =
    await Promise.all([
      prisma.project.findFirst({ where: { id: projectId, workspaceId }, select: { domain: true, locale: true } }),
      prisma.keyword.count({ where: { projectId } }),
      prisma.keyword.count({ where: { projectId, tracked: true } }),
      prisma.keyword.findMany({
        where: { projectId, tracked: true },
        orderBy: { volume: "desc" },
        take: 10,
        include: { rankings: { orderBy: { checkedAt: "desc" }, take: 1 } },
      }),
      prisma.issue.findMany({
        where: { projectId, status: "open" },
        take: 5,
        select: { type: true, severity: true, url: true },
      }),
      prisma.report.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        take: 3,
        include: { template: { select: { name: true } } },
      }),
      prisma.workflow.findMany({
        where: { projectId },
        orderBy: { updatedAt: "desc" },
        take: 8,
        select: { id: true, name: true, status: true, enabled: true },
      }),
    ]);

  const lines = [
    `Project: ${project?.domain ?? projectId} (locale ${project?.locale ?? "en-US"})`,
    `Keywords: ${keywordCount} saved, ${trackedCount} tracked`,
    topKeywords.length
      ? `Top tracked keywords: ${topKeywords.map((k) => `"${k.phrase}" (vol ${k.volume ?? "?"}, pos ${k.rankings[0]?.position ?? "—"})`).join(", ")}`
      : "Top tracked keywords: none yet",
    openIssues.length
      ? `Open issues (${openIssues.length} shown): ${openIssues.map((i) => `${i.severity}/${i.type}${i.url ? ` on ${i.url}` : ""}`).join("; ")}`
      : "Open issues: none",
    recentReports.length
      ? `Recent reports: ${recentReports.map((r) => `"${r.template?.name ?? "report"}" (${r.period}, ${r.status}, ${r.createdAt.toISOString().slice(0, 10)})`).join(", ")}`
      : "Recent reports: none",
    workflows.length
      ? `Workflows: ${workflows.map((w) => `"${w.name}" (${w.id}, ${w.status}, ${w.enabled ? "enabled" : "disabled"})`).join(", ")}`
      : "Workflows: none",
  ];
  return lines.join("\n");
}

function systemPrompt(
  projectContext: string,
  mockMode: boolean,
  supplements: string,
  intelligenceSection = "",
  agentKey: AgentKey = "lead",
  grant: readonly ToolGroup[] | null = null,
): string {
  const isLead = agentKey === "lead";
  return [
    // Expert Constitution Pack v1: the constitution is the system-prompt
    // layer — it sits in front of the project context (which carries M9
    // retrieval grounding downstream) and is never overridden by it.
    // Phase 5: a sub-agent gets its own role layer behind the same global
    // hard rules (lib/agents/roles.ts).
    isLead ? constitutionSystemPrompt("chief-strategy") : subAgentSystemPrompt(agentKey),
    "",
    // Phase 13B: company intelligence injects directly behind the global
    // hard rules — style rules are the first intelligence layer (hard
    // constraints, verbatim) so they always win on conflict.
    intelligenceSection,
    isLead
      ? "You are ShapesOS, the lead agent (Strategist) embedded in the user's workspace. You can hand focused work to a sub-agent with delegate_to_subagent."
      : `You are the ${agentDisplayName(agentKey)} sub-agent of ShapesOS, working inside the user's workspace.`,
    "You can ACT on the user's project using the tools below. Use read tools to ground your answers in real data; prefer a tool call over guessing.",
    grant
      ? `This task may only use these tool groups: ${grant.map((g) => TOOL_GROUP_LABELS[g]).join(", ")}. Calls outside them are refused.`
      : "",
    "",
    "PROJECT CONTEXT:",
    projectContext,
    "",
    supplements,
    "",
    "TOOLS:",
    toolCatalogForPrompt(grant),
    "",
    "RESPONSE FORMAT — reply with EITHER:",
    "  1. Plain text (when no tool is needed or when summarizing tool results), OR",
    '  2. A SINGLE JSON block, nothing else: {"tool_calls":[{"tool":"<name>","args":{...}}]}',
    "You may call multiple tools in one block when they are independent reads. After tool results are returned, write a plain-text summary for the user.",
    "",
    "RULES:",
    "- Never invent data: use tools for keywords, rankings, competitors, content, alerts, scores, workflows.",
    "- Write tools (spend/publish/destructive) and any tool requiring the editor role are held behind a confirmation gate by the runtime — you don't need to ask for confirmation yourself; just emit the tool call and the system will propose it to the user.",
    "- When a task matches an available skill, call the load_skill tool with its slug BEFORE acting.",
    '- Invoke connector tools as {"tool_calls":[{"tool":"connector.<key>.<toolName>","args":{...}}]} — args must include no credential; the runtime injects it.',
    "- Keep summaries short and concrete: what you did, the key numbers, and what to look at next.",
    mockMode ? "- NOTE: running in mock/demonstration mode." : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Milestone 21 (part C): parallel loader for the agent supplements —
 * enabled skill manifests, bound connector tool catalog, and attached
 * file contents. Skills + data sources are per project.
 */
async function buildAgentSupplements(
  projectId: string,
  workspaceId: string,
  grant: readonly ToolGroup[] | null = null,
): Promise<string> {
  const [skills, connectors] = await Promise.all([
    getEnabledProjectSkills(prisma, projectId).catch(() => []),
    connectorToolsSection(projectId, grant).catch(() => "## CONNECTOR TOOLS\n\nUnavailable."),
  ]);
  return [
    skillManifestSection(skills.map((s) => ({ name: s.name, description: s.description }))),
    "",
    connectors,
  ].join("\n");
}

const ATTACHMENT_TEXT_CAP = 50 * 1024;

async function readAttachmentText(
  attachmentId: string,
  projectId: string,
  storagePath: string,
  mimeType: string | null,
): Promise<string> {
  // Phase B (W3): compat read — registry ("fs:<id>") or legacy
  // ".data/attachments/..." rows.
  const { readAttachmentBytes } = await import("@/lib/filesystem/compat");
  const buf = await readAttachmentBytes({ id: attachmentId, projectId, storagePath });
  if (!buf) return "[file missing from disk]";
  const textLike =
    (mimeType ?? "").startsWith("text/") ||
    ["application/json", "application/csv", "application/xml", "application/javascript", "application/typescript"].includes(mimeType ?? "");
  if (!textLike) return "[binary file — not readable as text]";
  if (buf.includes(0)) return "[binary file — not readable as text]";
  return buf.toString("utf8").slice(0, ATTACHMENT_TEXT_CAP);
}

/**
 * Load attachment rows (must belong to the project), bind them to the
 * thread session on first use, and build the ATTACHED FILES prompt section.
 */
async function buildAttachmentSection(
  projectId: string,
  threadId: string,
  attachmentIds: string[] | undefined,
): Promise<string> {
  if (!attachmentIds || attachmentIds.length === 0) return "";
  const rows = await prisma.fileAttachment.findMany({
    where: { id: { in: attachmentIds }, projectId },
  });
  if (rows.length === 0) return "";
  await prisma.fileAttachment.updateMany({
    where: { id: { in: rows.map((r) => r.id) }, sessionId: null },
    data: { sessionId: threadId },
  });
  const parts = await Promise.all(
    rows.map(async (r) => {
      if (r.source === "upload" && r.storagePath) {
        return `- ${r.filename} (${r.mimeType ?? "unknown type"}):\n${await readAttachmentText(r.id, r.projectId, r.storagePath, r.mimeType)}`;
      }
      if (r.source === "connector") {
        return `- ${r.filename} (via connector ${r.connectorKey ?? "unknown"}: ${r.externalRef ?? "no reference"})`;
      }
      return `- ${r.filename}`;
    }),
  );
  return ["## ATTACHED FILES", "", ...parts].join("\n");
}

// ---------------------------------------------------------------------------
// JSON extraction (defensive)
// ---------------------------------------------------------------------------

function extractJsonBlock(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  // Fall back to the first balanced {…} block.
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

interface ParsedCalls {
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  ok: boolean;
}

function parseToolCalls(text: string): ParsedCalls {
  const block = extractJsonBlock(text);
  if (!block) return { calls: [], ok: false };
  try {
    const parsed = JSON.parse(block) as { tool_calls?: Array<{ tool?: string; args?: unknown }> };
    const calls = (parsed.tool_calls ?? [])
      .filter((c) => typeof c?.tool === "string")
      .map((c) => ({
        tool: c.tool as string,
        args: c.args && typeof c.args === "object" ? (c.args as Record<string, unknown>) : {},
      }));
    return { calls, ok: true };
  } catch {
    return { calls: [], ok: false };
  }
}

// ---------------------------------------------------------------------------
// Tool execution + audit
// ---------------------------------------------------------------------------

async function auditToolExecution(
  ctx: ToolContext,
  tool: ToolDef,
  summary: string,
  autoReason?: string,
): Promise<void> {
  await prisma.fileChangeLog
    .create({
      data: {
        projectId: ctx.projectId,
        workspaceId: ctx.workspaceId,
        filePath: `chat:${tool.name}:${ctx.projectId}`,
        actor: "ai",
        action: ctx.confirmed || autoReason ? "ai_applied" : "ai_proposal",
        summary: `[${tool.kind}] ${tool.name}: ${summary}${autoReason ? ` (${autoReason})` : ""}`.slice(0, 500),
        // An auto-approved call was not approved by a person.
        approvedBy: ctx.confirmed ? ctx.userId : null,
      },
    })
    .catch(() => {});
}

/** Phase 5: one line on the run's timeline (never fails the turn). */
async function runEvent(
  ctx: ToolContext,
  summary: string,
  payload?: Record<string, unknown>,
  type: "agui" | "gate" | "note" = "agui",
): Promise<void> {
  if (!ctx.runId) return;
  await appendAgentRunEvent(ctx.workspaceId, ctx.runId, { type, summary: summary.slice(0, 500), payload }).catch(() => undefined);
}

/**
 * Phase 5: has this run been asked to stop? The in-process signal answers at
 * once; otherwise the database is asked (Stop may come from another process),
 * and a stop found there also aborts this process's in-flight work.
 */
async function stopRequested(ctx: ToolContext): Promise<boolean> {
  if (ctx.signal?.aborted) return true;
  if (!ctx.runId) return false;
  const asked = await isAgentRunCancelRequested(ctx.workspaceId, ctx.runId).catch(() => false);
  if (asked) abortRun(ctx.runId);
  return asked;
}

async function executeTool(
  ctx: ToolContext,
  toolName: string,
  args: Record<string, unknown>,
  call: ChatToolCall,
): Promise<void> {
  // Phase 5: a stopped run runs nothing more.
  if (await stopRequested(ctx)) {
    call.status = "cancelled";
    call.resultSummary = `Not run — the task was stopped.`;
    return;
  }
  if (ctx.agentKey && !call.agentKey) call.agentKey = ctx.agentKey;
  const tool = getTool(toolName);
  if (!tool) {
    // Dynamic connector tools (milestone 21): connector.<key>.<toolName>.
    if (toolName.startsWith("connector.")) {
      const outcome = await resolveConnectorTool(toolName, ctx, args);
      call.status = outcome.status;
      call.resultSummary = outcome.resultSummary;
      if (outcome.status === "pending_confirmation" && ctx.grant) call.grant = [...ctx.grant];
      if (outcome.autoAction) call.autoAction = outcome.autoAction;
      await runEvent(ctx, `${toolName}: ${outcome.status.replace(/_/g, " ")}`, { tool: toolName, status: outcome.status }, outcome.status === "denied" ? "gate" : "agui");
      return;
    }
    call.status = "error";
    call.resultSummary = `Unknown tool "${toolName}". Available: ${allTools()
      .filter((t) => toolGranted(t.name, ctx.grant))
      .map((t) => t.name)
      .join(", ")}`;
    return;
  }
  // Phase 5: the task's tool grant, checked before anything runs. The model
  // only ever sees granted tools, so this is the backstop for a model that
  // names a tool anyway.
  if (!toolGranted(tool.name, ctx.grant)) {
    const group = toolGroup(tool.name);
    call.status = "denied";
    call.resultSummary = `This task isn't allowed to use ${TOOL_GROUP_LABELS[group]} tools (${tool.name}).`;
    await auditToolExecution(ctx, tool, `DENIED (outside the task's tool grant: ${group})`);
    await runEvent(ctx, `Refused ${tool.name}: outside this task's tools`, { tool: tool.name, group }, "gate");
    return;
  }
  if (!roleAtLeast(ctx.role, tool.minRole)) {
    call.status = "skipped_role";
    call.resultSummary = `Tool "${toolName}" needs the ${tool.minRole} role (you have ${ctx.role}).`;
    return;
  }
  // Confirmation gate: non-safe tools only run after an explicit "yes" —
  // or, Phase 5, when a per-agent auto-approve rule covers a Tier 0/1
  // action. Destructive tools always ask.
  let autoReason: string | undefined;
  if (tool.kind !== "safe" && !ctx.confirmed) {
    const decision =
      tool.kind === "destructive"
        ? null
        : await autoApprovalFor(ctx.workspaceId, {
            agentKey: ctx.agentKey ?? "lead",
            action: toolAction(tool.name),
            description: `${tool.name}: ${tool.description}`,
          }).catch(() => null);
    if (!decision?.auto) {
      call.status = "pending_confirmation";
      call.resultSummary = `Proposed ${tool.name} (${tool.kind}) — awaiting confirmation`;
      if (ctx.grant) call.grant = [...ctx.grant];
      if (decision && decision.tier <= 1) call.autoAction = toolAction(tool.name);
      await runEvent(ctx, `Waiting for your OK: ${tool.name}`, { tool: tool.name, kind: tool.kind }, "gate");
      return;
    }
    autoReason = decision.reason;
    call.autoApproved = decision.reason;
  }
  try {
    const result = await tool.execute(ctx, args);
    call.status = "executed";
    call.resultSummary = result.summary;
    collectDelegated(call, result);
    await auditToolExecution(ctx, tool, result.summary, autoReason);
    // Phase 8: a tool that recorded its own (richer) run event — the ship and
    // browser tools — is not recorded twice.
    if (!recordedOwnEvent(result)) {
      await runEvent(ctx, `${tool.name}: ${result.summary}`, {
        tool: tool.name,
        ...(autoReason ? { autoApproved: autoReason } : {}),
        ...approvalRef(result),
      });
    }
  } catch (err) {
    if (isRunStopped(err)) {
      call.status = "cancelled";
      call.resultSummary = "Stopped while running.";
      return;
    }
    call.status = "error";
    call.resultSummary = err instanceof Error ? err.message : `${toolName} failed`;
    await auditToolExecution(ctx, tool, `FAILED: ${call.resultSummary}`, autoReason);
    await runEvent(ctx, `${tool.name} failed: ${call.resultSummary}`, { tool: tool.name });
  }
}

function recordedOwnEvent(result: ToolResult): boolean {
  const d = result.details as Record<string, unknown> | undefined;
  return !!d && d[TOOL_RECORDED_EVENT] === true;
}

/** Keep the approval a tool raised on the run timeline (so Stop can expire it). */
function approvalRef(result: ToolResult): Record<string, unknown> {
  const d = result.details as { approvalId?: unknown } | undefined;
  return d && typeof d.approvalId === "string" ? { approvalId: d.approvalId } : {};
}

/** delegate_to_subagent returns the sub-agent's own calls; keep them on the call. */
function collectDelegated(call: ChatToolCall, result: ToolResult): void {
  const d = result.details as { calls?: unknown } | undefined;
  if (call.tool === DELEGATE_TOOL && d && Array.isArray(d.calls)) {
    call.delegated = d.calls as ChatToolCall[];
  }
}

function proposalText(call: ChatToolCall): string {
  const tool = getTool(call.tool);
  const kind = tool?.kind ?? "write";
  const args = Object.entries(call.args)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
  const who =
    call.agentKey && isAgentKey(call.agentKey) && call.agentKey !== "lead"
      ? `The ${agentDisplayName(call.agentKey)} sub-agent would like`
      : "I'd like";
  return [
    `${who} to run **${call.tool}** (${kind} action)${args ? ` with ${args}` : ""}.`,
    `${tool?.description ?? ""}`,
    `Reply **yes** to confirm, or send a new message to cancel.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Mock-mode rule-based router
// ---------------------------------------------------------------------------

async function mockTurn(
  ctx: ToolContext,
  userContent: string,
): Promise<{ text: string; toolCalls: ChatToolCall[] }> {
  const text = userContent.trim();
  const lower = text.toLowerCase();

  const run = async (toolName: string, args: Record<string, unknown>): Promise<ChatToolCall> => {
    const call: ChatToolCall = { tool: toolName, args, status: "executed" };
    await executeTool({ ...ctx, confirmed: true }, toolName, args, call);
    return call;
  };

  const propose = async (toolName: string, args: Record<string, unknown>): Promise<ChatToolCall> => {
    const call: ChatToolCall = { tool: toolName, args, status: "pending_confirmation" };
    await executeTool(ctx, toolName, args, call);
    return call;
  };

  const first = lower.split(/\s+/)[0];
  switch (first) {
    case "/help":
      return { text: ["I'm running in mock mode (no LLM key configured), so I answer via slash commands:", "", SLASH_HELP].join("\n"), toolCalls: [] };
    case "/keywords": {
      const call = await run("get_keywords", { limit: "25" });
      return { text: `**Keywords**\n${formatDetails(call)}`, toolCalls: [call] };
    }
    case "/rankings": {
      const call = await run("get_rankings", {});
      return { text: `**Rankings**\n${formatDetails(call)}`, toolCalls: [call] };
    }
    case "/alerts": {
      const call = await run("get_alerts", {});
      return { text: `**Alerts**\n${formatDetails(call)}`, toolCalls: [call] };
    }
    case "/competitors": {
      const call = await run("get_competitors", {});
      return { text: `**Competitors**\n${formatDetails(call)}`, toolCalls: [call] };
    }
    case "/draft": {
      const topic = text.slice("/draft".length).trim();
      if (!topic) return { text: "Usage: `/draft <topic>` — e.g. `/draft espresso machines`", toolCalls: [] };
      const call = await propose("create_content_draft", { topic });
      return { text: proposalText(call), toolCalls: [call] };
    }
    case "/audit": {
      const rest = text.slice("/audit".length).trim();
      const call = await propose("run_seo_audit", rest ? { siteId: rest } : {});
      return { text: proposalText(call), toolCalls: [call] };
    }
    case "/report": {
      const rest = text.slice("/report".length).trim();
      const call = await propose("create_report", rest ? { templateId: rest } : {});
      return { text: proposalText(call), toolCalls: [call] };
    }
    case "/workflow": {
      const rest = text.slice("/workflow".length).trim();
      if (!rest) return { text: "Usage: `/workflow <id or name>`", toolCalls: [] };
      const call = await propose("run_workflow", { workflowId: rest });
      return { text: proposalText(call), toolCalls: [call] };
    }
    case "/approve": {
      const rest = text.slice("/approve".length).trim();
      if (!rest) return { text: "Usage: `/approve <itemId>`", toolCalls: [] };
      const call = await propose("approve_autopilot_item", { itemId: rest });
      return { text: proposalText(call), toolCalls: [call] };
    }
    default:
      return {
        text: [
          "I can read your ShapesOS project and take actions in it. In mock mode (no LLM key) I work from slash commands:",
          "",
          SLASH_HELP,
        ].join("\n"),
        toolCalls: [],
      };
  }
}

function formatDetails(call: ChatToolCall): string {
  if (call.status !== "executed") return call.resultSummary ?? "failed";
  const tool = getTool(call.tool);
  if (!tool) return call.resultSummary ?? "";
  const summary = call.resultSummary ?? "";
  if (call.tool === "get_rankings") {
    return summary;
  }
  if (call.tool === "get_keywords") {
    return `${summary}. Use get_keywords with a list filter or higher limit to see more.`;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

async function saveMessage(
  threadId: string,
  role: "user" | "assistant" | "tool",
  content: string,
  toolCalls?: ChatToolCall[],
): Promise<string> {
  const msg = await prisma.aiChatMessage.create({
    data: {
      threadId,
      role,
      content,
      toolCalls: toolCalls ? (toolCalls as unknown as object) : undefined,
    },
  });
  await prisma.aiChatThread.update({
    where: { id: threadId },
    data: { updatedAt: new Date() },
  });
  return msg.id;
}

export async function pendingProposal(threadId: string): Promise<ChatToolCall[] | null> {
  const lastAssistant = await prisma.aiChatMessage.findFirst({
    where: { threadId, role: "assistant" },
    orderBy: { createdAt: "desc" },
    select: { toolCalls: true },
  });
  if (!lastAssistant?.toolCalls || !Array.isArray(lastAssistant.toolCalls)) return null;
  const calls = lastAssistant.toolCalls as unknown as ChatToolCall[];
  const pending = calls.filter((c) => c.status === "pending_confirmation");
  return pending.length ? pending : null;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export interface AgentTurnInput {
  projectId: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  threadId: string;
  userContent: string;
  /** FileAttachment ids to include in this turn (validated against the project). */
  attachmentIds?: string[];
  /** Phase 5: the agent this turn runs as (default the lead). */
  agentKey?: AgentKey;
  /** Phase 5: the task's tool grant (null/absent = role checks only). */
  grant?: readonly ToolGroup[] | null;
  /** Phase 5: the AgentRun recording this turn (runTrackedAgentTurn sets it). */
  runId?: string;
  /** Phase 5: aborted when the run is stopped. */
  signal?: AbortSignal;
}

export interface AgentTurnOutput {
  assistantText: string;
  toolCalls: ChatToolCall[];
  threadTitle: string | null;
  /** Phase 5: true when the turn ended because the run was stopped. */
  cancelled?: boolean;
  /** Phase 5: true when the turn ended waiting for the user's "yes". */
  awaitingConfirmation?: boolean;
}

const STOPPED_TEXT = "Stopped. Nothing else will run for this task.";

/** ToolContext plus the thread a delegated sub-agent writes its tool rows to. */
type LoopContext = ToolContext & { threadId?: string };

interface LoopInput {
  ctx: LoopContext;
  threadId: string;
  sys: string;
  userContent: string;
  maxIterations: number;
}

interface LoopOutput {
  finalText: string;
  calls: ChatToolCall[];
  cancelled: boolean;
  proposal: ChatToolCall | null;
}

/**
 * The live tool loop (shared by a turn and a delegated sub-agent's run).
 * Phase 5: checks for a stop before every model call (executeTool checks
 * before every tool call) and passes the run's abort signal to the model
 * call, so Stop ends it mid-flight.
 */
async function runToolLoop({ ctx, threadId, sys, userContent, maxIterations }: LoopInput): Promise<LoopOutput> {
  // Phase D: the chat agent loop runs on the "bulk" workload.
  const llm = getLlmProviderFor("bulk");
  const transcript: Array<{ role: "user" | "assistant"; content: string }> = [
    { role: "user", content: userContent },
  ];
  const calls: ChatToolCall[] = [];
  let finalText = "";

  for (let i = 0; i < maxIterations; i++) {
    if (await stopRequested(ctx)) return { finalText: STOPPED_TEXT, calls, cancelled: true, proposal: null };
    const prompt = [
      sys,
      "",
      "CONVERSATION:",
      ...transcript.map((m) => `${m.role === "user" ? "USER" : "ASSISTANT"}: ${m.content}`),
      "ASSISTANT:",
    ].join("\n");

    let response: string;
    try {
      response = await llm.generate(prompt, ctx.signal ? { signal: ctx.signal } : undefined);
    } catch (err) {
      if (isRunStopped(err) || ctx.signal?.aborted) {
        return { finalText: STOPPED_TEXT, calls, cancelled: true, proposal: null };
      }
      finalText = `The AI provider failed: ${err instanceof Error ? err.message : "unknown error"}. Try again, or use slash commands in mock mode.`;
      break;
    }

    const parsed = parseToolCalls(response);
    if (!parsed.ok || parsed.calls.length === 0) {
      finalText = response.trim();
      break;
    }

    // Execute the tool calls.
    const iterationCalls: ChatToolCall[] = parsed.calls.map((c) => ({
      tool: c.tool,
      args: c.args,
      status: "executed" as const,
    }));
    const results: string[] = [];
    let proposal: ChatToolCall | null = null;
    let stopped = false;
    for (const call of iterationCalls) {
      await executeTool(ctx, call.tool, call.args, call);
      calls.push(call);
      if (call.status === "cancelled") {
        stopped = true;
        continue;
      }
      if (call.status === "executed") {
        await saveMessage(threadId, "tool", call.resultSummary ?? "", [call]);
        results.push(`TOOL RESULT (${call.tool}): ${call.resultSummary}`);
        // A sub-agent's proposal surfaces as this turn's proposal.
        const subProposal = call.delegated?.find((c) => c.status === "pending_confirmation");
        if (subProposal && !proposal) proposal = subProposal;
      } else if (call.status === "pending_confirmation") {
        if (!proposal) proposal = call;
        results.push(`TOOL PROPOSED (${call.tool}) — needs user confirmation, do NOT execute yet.`);
      } else {
        results.push(`TOOL ${call.status.toUpperCase()} (${call.tool}): ${call.resultSummary}`);
      }
    }
    if (stopped || ctx.signal?.aborted) {
      return { finalText: STOPPED_TEXT, calls, cancelled: true, proposal: null };
    }
    transcript.push({ role: "assistant", content: response.trim() });
    transcript.push({ role: "user", content: results.join("\n") });

    if (proposal) {
      // Propose the FIRST pending action to the user and stop the loop.
      // Mark the remaining proposals as skipped so nothing leaks through later.
      for (const c of iterationCalls) {
        if (c.status === "pending_confirmation" && c !== proposal) c.status = "error";
        for (const d of c.delegated ?? []) {
          if (d.status === "pending_confirmation" && d !== proposal) d.status = "error";
        }
      }
      // A sub-agent's proposal is lifted to the top level so the user's
      // "yes" finds it (pendingProposal reads top-level calls only).
      if (!calls.includes(proposal)) calls.push(proposal);
      return { finalText: proposalText(proposal), calls, cancelled: false, proposal };
    }
  }

  return { finalText, calls, cancelled: false, proposal: null };
}

export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnOutput> {
  const { projectId, workspaceId, userId, role, threadId, userContent, attachmentIds } = input;
  const trimmed = userContent.trim();
  const agentKey: AgentKey = input.agentKey ?? "lead";
  const grant = input.grant ?? null;

  // Turn-scoped skill loading state (milestone 21): load_skill records slugs
  // here; the connector-tool declared-tool gate reads them.
  const loadedSkills = new Set<string>();
  const baseCtx: LoopContext = {
    projectId,
    workspaceId,
    userId,
    role,
    confirmed: false,
    loadedSkills,
    agentKey,
    grant,
    runId: input.runId,
    signal: input.signal,
    threadId,
  };

  // 1. Confirmation path: "yes" + a pending proposal → execute it.
  if (CONFIRM_RE.test(trimmed)) {
    const pending = await pendingProposal(threadId);
    if (pending?.length) {
      const executed: ChatToolCall[] = [];
      for (const call of pending) {
        // Phase 5: run as the agent that proposed it, inside the grant it
        // was proposed under — never wider than the thread's grant now.
        const callAgent = call.agentKey && isAgentKey(call.agentKey) ? call.agentKey : agentKey;
        const callGrant = call.grant
          ? (call.grant.filter((g) => !grant || grant.includes(g as ToolGroup)) as ToolGroup[])
          : grant;
        const ctx: LoopContext = { ...baseCtx, confirmed: true, agentKey: callAgent, grant: callGrant };
        const exec: ChatToolCall = { tool: call.tool, args: call.args, confirmed: true, status: "executed", agentKey: callAgent };
        await executeTool(ctx, call.tool, call.args, exec);
        executed.push(exec);
        await saveMessage(threadId, "tool", exec.resultSummary ?? "", [exec]);
      }
      const cancelled = executed.some((c) => c.status === "cancelled");
      const failures = executed.filter((c) => c.status !== "executed");
      const text = cancelled
        ? STOPPED_TEXT
        : failures.length === 0
          ? `Done. ${executed.map((c) => c.resultSummary).join(" ")}`
          : `Partially done. ${executed.map((c) => (c.status === "executed" ? `✔ ${c.resultSummary}` : `✘ ${c.tool}: ${c.resultSummary}`)).join("\n")}`;
      await saveMessage(threadId, "assistant", text, executed);
      return { assistantText: text, toolCalls: executed, threadTitle: null, cancelled };
    }
    // "yes" with nothing pending — fall through to a normal turn.
  }

  const isLive = llmStatus().isLive;

  // 2. Mock mode: deterministic rule-based router.
  if (!isLive) {
    // Attachments still bind to the thread in mock mode.
    await buildAttachmentSection(projectId, threadId, attachmentIds);
    const { text, toolCalls } = await mockTurn(baseCtx, trimmed);
    // Persist tool messages for executed reads (mirrors live mode).
    for (const call of toolCalls) {
      if (call.status === "executed") {
        await saveMessage(threadId, "tool", call.resultSummary ?? "", [call]);
      }
    }
    const cancelled = toolCalls.some((c) => c.status === "cancelled");
    const finalText = cancelled ? STOPPED_TEXT : text;
    await saveMessage(threadId, "assistant", finalText, toolCalls);
    return {
      assistantText: finalText,
      toolCalls,
      threadTitle: null,
      cancelled,
      awaitingConfirmation: toolCalls.some((c) => c.status === "pending_confirmation"),
    };
  }

  // 3. Live mode: prompt-engineered agent loop.
  const [projectContext, supplements, attachmentSection, intelligenceSection] = await Promise.all([
    buildProjectContext(projectId, workspaceId),
    buildAgentSupplements(projectId, workspaceId, grant),
    buildAttachmentSection(projectId, threadId, attachmentIds),
    // Phase 13B: layered company intelligence (rules → voice → knowledge →
    // lessons/prefs → episodes); degrades to "" when the workspace has none.
    buildIntelligenceContext(workspaceId, trimmed).catch(() => ""),
  ]);
  const sys = systemPrompt(
    projectContext,
    false,
    [supplements, attachmentSection].filter(Boolean).join("\n\n"),
    intelligenceSection,
    agentKey,
    grant,
  );

  const loop = await runToolLoop({
    ctx: baseCtx,
    threadId,
    sys,
    userContent: trimmed,
    maxIterations: MAX_ITERATIONS,
  });
  const turnCalls = loop.calls;
  let finalText = loop.finalText;

  if (!finalText) {
    finalText = "I checked everything I could. Let me know if you'd like me to dig deeper.";
  }
  // Phase 13B: fail-closed style-rule enforcement on the Chief Strategy
  // Agent delivery path. A severity=block violation refuses delivery — the
  // violating text is replaced with a refusal naming the rule. Infra
  // failures in the checker degrade open so a broken style subsystem can't
  // take down the whole agent; rule-compile failures are already contained
  // per-rule inside checkOutput.
  if (!loop.cancelled) {
    try {
      await enforceStyleRules(finalText, workspaceId);
    } catch (err) {
      if (err instanceof StyleRuleBlockedError) {
        finalText =
          `I can't deliver that response as written — it violates your style ` +
          `rule${err.violations.length > 1 ? "s" : ""}: ` +
          err.violations.map((v) => `"${v.pattern}" (${v.kind})`).join(", ") +
          `. Adjust the request or the rule and try again.`;
      }
      // Non-block errors: deliver as-is (see note above).
    }
  }
  await saveMessage(threadId, "assistant", finalText, turnCalls);
  return {
    assistantText: finalText,
    toolCalls: turnCalls,
    threadTitle: null,
    cancelled: loop.cancelled,
    awaitingConfirmation: loop.proposal !== null,
  };
}

// ---------------------------------------------------------------------------
// Phase 5: hand a task to one sub-agent (the lead's delegate tool).
// ---------------------------------------------------------------------------

export const DELEGATE_TOOL = "delegate_to_subagent";

const SUB_AGENT_MAX_ITERATIONS = 6;

const delegate_to_subagent: ToolDef = {
  name: DELEGATE_TOOL,
  description:
    "Hand one focused piece of work to a sub-agent and get its result back. agent is one of: researcher, planner, drafter (Writer), analyst, scheduler, actor (Operator). The sub-agent works inside this task's tools (optionally fewer) and its write actions still wait for the user's OK.",
  // Safe to call: the sub-agent's own tools go through every gate.
  kind: "safe",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      agent: { type: "string", description: "Sub-agent key: researcher | planner | drafter | analyst | scheduler | actor (required)." },
      task: { type: "string", description: "What the sub-agent should do, with the context it needs (required)." },
      tools: { type: "string", description: 'Optional comma-separated tool groups to narrow it further (e.g. "web,files").' },
    },
    required: ["agent", "task"],
  },
  async execute(ctx, args) {
    const sub = typeof args.agent === "string" ? args.agent.trim() : "";
    const task = typeof args.task === "string" ? args.task.trim().slice(0, 4000) : "";
    if (!isAgentKey(sub) || sub === "lead") {
      throw new Error(`Unknown sub-agent "${sub}". Use one of: researcher, planner, drafter, analyst, scheduler, actor.`);
    }
    if ((ctx.agentKey ?? "lead") !== "lead") {
      throw new Error("Only the lead agent can hand work to a sub-agent.");
    }
    if (!task) throw new Error("Say what the sub-agent should do (task).");
    const requested =
      typeof args.tools === "string" && args.tools.trim()
        ? args.tools.split(",").map((t) => t.trim()).filter(Boolean)
        : null;
    const parentGrant = ctx.grant ?? AGENT_MAX_GROUPS.lead;
    const childGrant = computeGrant({ agentKey: sub, requested, parentGrant });
    const name = agentDisplayName(sub);
    const threadId = (ctx as LoopContext).threadId;

    // The child run: same workspace and thread, pointing at the lead's run.
    let childRunId: string | undefined;
    if (ctx.runId) {
      const child = await createAgentRun({
        workspaceId: ctx.workspaceId,
        kind: "chat",
        startedBy: ctx.userId,
        threadId,
        agentKey: sub,
        parentRunId: ctx.runId,
        allowedTools: childGrant.groups,
        agentState: { task: task.slice(0, 500), projectId: ctx.projectId },
      });
      childRunId = child.id;
      await markAgentRunRunning(ctx.workspaceId, child.id);
      await runEvent(ctx, `Handed to ${name}: ${task.slice(0, 200)}`, { childRunId, agent: sub, grant: childGrant.groups }, "note");
    }
    const childCtx: LoopContext = {
      ...ctx,
      confirmed: false,
      agentKey: sub,
      grant: childGrant.groups,
      runId: childRunId ?? ctx.runId,
      threadId,
    };

    let loop: LoopOutput;
    try {
      if (!llmStatus().isLive || !threadId) {
        loop = {
          finalText: `${name} needs a live model to work on its own; the hand-off was recorded.`,
          calls: [],
          cancelled: false,
          proposal: null,
        };
      } else {
        const [projectContext, supplements] = await Promise.all([
          buildProjectContext(ctx.projectId, ctx.workspaceId),
          buildAgentSupplements(ctx.projectId, ctx.workspaceId, childGrant.groups),
        ]);
        const sys = systemPrompt(projectContext, false, supplements, "", sub, childGrant.groups);
        loop = await runToolLoop({
          ctx: childCtx,
          threadId,
          sys,
          userContent: task,
          maxIterations: SUB_AGENT_MAX_ITERATIONS,
        });
      }
    } catch (err) {
      if (childRunId) await finishAgentRun(ctx.workspaceId, childRunId, "failed").catch(() => undefined);
      throw err;
    }
    if (childRunId) {
      await finishAgentRun(ctx.workspaceId, childRunId, loop.cancelled ? "cancelled" : "succeeded").catch(() => undefined);
    }
    const calls = loop.calls.map((c) => ({ ...c, agentKey: c.agentKey ?? sub }));
    if (loop.cancelled) {
      // The whole task was stopped: stop the lead too.
      // (ctx is the lead's context here, so this asks about the lead's run.)
      if (await stopRequested(ctx)) throw new RunStoppedError();
      // Only this sub-agent was stopped (Runs page): the lead carries on.
      return {
        summary: `${name} was stopped before it finished.`,
        details: { subRunId: childRunId ?? null, agent: sub, grant: childGrant.groups, calls, stopped: true },
      };
    }
    const dropped = childGrant.dropped.length ? ` (not allowed: ${childGrant.dropped.join(", ")})` : "";
    return {
      summary: `${name}: ${loop.finalText || "done"}${dropped}`.slice(0, 2000),
      details: { subRunId: childRunId ?? null, agent: sub, grant: childGrant.groups, calls },
    };
  },
};

registerExtraTool(delegate_to_subagent);

// ---------------------------------------------------------------------------
// Phase 5: tracked turns — every assistant turn is an AgentRun.
// ---------------------------------------------------------------------------

/** The thread's task profile: its agent and server-computed grant. */
export async function threadTaskProfile(threadId: string): Promise<{ agentKey: AgentKey; grant: ToolGroup[] }> {
  const t = await prisma.aiChatThread.findUnique({
    where: { id: threadId },
    select: { agentKey: true, allowedTools: true },
  });
  const agentKey: AgentKey = t && isAgentKey(t.agentKey) ? t.agentKey : "lead";
  // Re-computed every turn: a stored grant can never outgrow the agent.
  return { agentKey, grant: computeGrant({ agentKey, requested: t?.allowedTools ?? [] }).groups };
}

/**
 * Collect the approvals a set of runs raised (recorded on their timelines by
 * executeTool) and expire the ones still pending. Never throws.
 */
async function expireRunApprovals(workspaceId: string, runIds: string[], stoppedBy: string): Promise<void> {
  try {
    const { withWorkspaceScope } = await import("@/lib/substrate/memory/rls");
    const events = await withWorkspaceScope(workspaceId, (tx) =>
      tx.agentRunEvent.findMany({
        where: { workspaceId, runId: { in: runIds } },
        select: { payload: true },
      }),
    );
    const ids = events
      .map((e) => (e.payload as { approvalId?: unknown } | null)?.approvalId)
      .filter((x): x is string => typeof x === "string");
    if (ids.length) await expireApprovalsForStoppedRun(workspaceId, [...new Set(ids)], stoppedBy);
  } catch {
    // Best effort: the approval still expires on its own clock.
  }
}

/**
 * Mark the thread's still-pending proposals cancelled, so a "yes" sent after
 * Stop finds nothing to run.
 */
async function cancelPendingProposals(threadId: string): Promise<void> {
  const last = await prisma.aiChatMessage.findFirst({
    where: { threadId, role: "assistant" },
    orderBy: { createdAt: "desc" },
    select: { id: true, toolCalls: true },
  });
  if (!last?.toolCalls || !Array.isArray(last.toolCalls)) return;
  const calls = last.toolCalls as unknown as ChatToolCall[];
  if (!calls.some((c) => c.status === "pending_confirmation")) return;
  const next = calls.map((c) =>
    c.status === "pending_confirmation" ? { ...c, status: "cancelled" as const, resultSummary: "Dropped — the task was stopped." } : c,
  );
  await prisma.aiChatMessage.update({ where: { id: last.id }, data: { toolCalls: next as unknown as object } });
}

/**
 * Phase 5: Stop a thread's work. Records the stop on its live runs (and their
 * sub-agent runs), aborts any in-flight model call in this process, drops the
 * thread's pending proposals and expires the approvals those runs raised.
 * Returns the run ids asked to stop.
 */
export async function stopThreadRuns(input: {
  workspaceId: string;
  threadId: string;
  userId: string;
  runId?: string;
}): Promise<string[]> {
  const { listLiveThreadRuns, requestAgentRunCancel } = await import("@/lib/agents/runs/service");
  const targets = input.runId
    ? [input.runId]
    : (await listLiveThreadRuns(input.workspaceId, input.threadId)).filter((r) => !r.parentRunId).map((r) => r.id);
  const stopped: string[] = [];
  for (const id of targets) {
    const res = await requestAgentRunCancel(input.workspaceId, id, input.userId);
    if (res?.stopped) stopped.push(...res.runIds);
  }
  for (const id of stopped) abortRun(id);
  await cancelPendingProposals(input.threadId).catch(() => undefined);
  if (stopped.length) await expireRunApprovals(input.workspaceId, stopped, input.userId);
  return stopped;
}

/**
 * Phase 5: the turn entry point for request handlers. Records the turn as an
 * AgentRun (kind chat) running as the thread's agent inside its grant, wires
 * Stop to it, and finishes it as succeeded / failed / cancelled.
 */
export async function runTrackedAgentTurn(
  input: AgentTurnInput,
  opts: { capture?: typeof captureEpisode } = {},
): Promise<AgentTurnOutput & { runId: string }> {
  const profile = await threadTaskProfile(input.threadId);
  const run = await createAgentRun({
    workspaceId: input.workspaceId,
    kind: "chat",
    startedBy: input.userId,
    threadId: input.threadId,
    agentKey: profile.agentKey,
    allowedTools: profile.grant,
    agentState: { projectId: input.projectId, prompt: input.userContent.slice(0, 280) },
  });
  await markAgentRunRunning(input.workspaceId, run.id);
  const signal = registerRunAbort(run.id);
  try {
    const out = await runAgentTurnWithCapture(
      { ...input, agentKey: profile.agentKey, grant: profile.grant, runId: run.id, signal },
      opts,
    );
    if (out.cancelled) {
      await finishAgentRun(input.workspaceId, run.id, "cancelled");
      await cancelPendingProposals(input.threadId).catch(() => undefined);
      await expireRunApprovals(input.workspaceId, [run.id], input.userId);
    } else {
      if (out.awaitingConfirmation) {
        await appendAgentRunEvent(input.workspaceId, run.id, {
          type: "gate",
          summary: "Waiting for your OK in the chat",
        }).catch(() => undefined);
      }
      await finishAgentRun(input.workspaceId, run.id, "succeeded");
    }
    return { ...out, runId: run.id };
  } catch (err) {
    await finishAgentRun(input.workspaceId, run.id, isRunStopped(err) ? "cancelled" : "failed").catch(() => undefined);
    throw err;
  } finally {
    releaseRunAbort(run.id);
  }
}

/**
 * Phase 13B: runAgentTurn with episode capture. Records one agent_call
 * episode per chat turn (outcome "error" when the turn throws) via the
 * fail-soft capture path — a capture failure never breaks the turn, and
 * learning-paused workspaces record nothing. Prefer this entry point over
 * bare runAgentTurn in request handlers.
 */
export async function runAgentTurnWithCapture(
  input: AgentTurnInput,
  opts: { capture?: typeof captureEpisode } = {},
): Promise<AgentTurnOutput> {
  const startedAt = new Date();
  let output: AgentTurnOutput | undefined;
  let outcome = "error";
  try {
    output = await runAgentTurn(input);
    const executed = output.toolCalls.filter((c) => c.status === "executed").length;
    outcome = executed > 0 ? `tools_executed:${executed}` : "answered";
    return output;
  } finally {
    const capture = opts.capture ?? captureEpisode;
    void capture({
      workspaceId: input.workspaceId,
      agentId: "chief-strategy",
      promptSummary: input.userContent,
      outputSummary: output?.assistantText,
      outcome,
      startedAt,
      endedAt: new Date(),
      refs: { threadId: input.threadId, projectId: input.projectId },
    });
  }
}

/** Auto-title a thread from its first user message (called by the route). */
export async function maybeAutoTitle(threadId: string, firstMessage: string): Promise<string | null> {
  const title = firstMessage.trim().slice(0, 48).replace(/\s+/g, " ");
  if (!title) return null;
  const updated = await prisma.aiChatThread.updateMany({
    where: { id: threadId, title: "New chat" },
    data: { title },
  });
  return updated.count > 0 ? title : null;
}
