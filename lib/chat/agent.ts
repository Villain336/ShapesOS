// Marketr — AI chat agent (redesign §3a; Phase 8: native agent loop).
//
// A chat turn:
//   1. Build project context (domain, keywords, rankings, alerts, reports,
//      workflows), company intelligence, skills and attachments into ONE
//      stable system prompt, plus the thread's recent history.
//   2. Run the native agent loop (lib/agents/loop.ts): Phase 7 chat() with
//      native tools, streaming, caching, adaptive thinking, compaction, and
//      step / time / cost caps (no JSON-in-text, no fixed 6 iterations).
//   3. Enforce the workspace's style rules on the final text (fail-closed).
//   4. Persist every turn as AiChatMessage rows (user / assistant / tool).
//
// CONFIRMATION GATE: destructive/publish/spend tools NEVER execute from a
// single message. The assistant first proposes the action and asks for
// confirmation; the proposal is stored in the assistant message's toolCalls
// JSON with status "pending_confirmation". Only when the next user message
// matches /^(yes|confirm|do it|go ahead|approved)/i does the tool execute —
// with the confirmation recorded in the audit log — and (Phase 8) the model
// then carries on from the same transcript with the real result.
//
// MOCK MODE: when the agent's workload has no live provider, a deterministic
// rule-based router handles slash commands so the page is fully demonstrable.
//
// PHASE 5 — the four agent controls, enforced on the server:
//   * Hand a task to one sub-agent: a thread carries its agent (lead or a
//     sub-agent) and every turn runs AS that agent (its role prompt, its
//     tools); the lead can hand work off with delegate_to_subagent, which
//     runs the sub-agent as a child AgentRun (parentRunId).
//   * Limit a task's tools: the thread's grant (lib/agents/grants.ts) filters
//     the tools the model is given AND executeTool / resolveConnectorTool
//     refuse anything outside it (status "denied", audited). A child's grant
//     is always inside its parent's.
//   * Stop: runTrackedAgentTurn records each turn as an AgentRun; the loop
//     checks for a stop before every model call and every tool call, aborts
//     an in-flight model call, cancels the turn's pending proposals and
//     expires the approvals it raised.
//   * Auto-approve: a per-agent rule (lib/automation/policy.ts) may let a
//     Tier 0/1 action run without the "yes" — Tier 2/3 and destructive tools
//     always ask, whatever the rule says.
//
// PHASE 8 — durable runs: a turn still working after AGENT_INLINE_BUDGET_SECONDS
// hands off to the agent worker at its next step boundary (the transcript is
// saved after every step); build-mode turns go to the worker straight away.
// The request answers `queued` and the run keeps streaming its events.

import { prisma } from "@/lib/prisma";
import type { WorkspaceRole } from "@prisma/client";
import { getLlmProviderFor } from "@/lib/llm";
import { workloadForAgent } from "@/lib/llm/router";
import type { ChatMessage, ChatToolResultBlock } from "@/lib/llm/types";
import { getTool, registerExtraTool, type ToolContext, type ToolDef } from "./tools";
import {
  DELEGATE_TOOL,
  executeTool,
  proposalText,
  runEvent,
  stopRequested,
  type ChatToolCall,
  type LoopContext,
} from "./tool-exec";
import {
  AGENT_MAX_GROUPS,
  TOOL_GROUP_LABELS,
  agentDisplayName,
  computeGrant,
  isAgentKey,
  type AgentKey,
  type ToolGroup,
} from "@/lib/agents/grants";
import { buildModeSystemPrompt, subAgentSystemPrompt } from "@/lib/agents/roles";
import { registerCodeTools } from "@/lib/sandbox/tools";
import { sandboxAvailability } from "@/lib/sandbox/index";
import {
  appendAgentRunEvent,
  createAgentRun,
  finishAgentRun,
  getAgentRun,
  markAgentRunRunning,
} from "@/lib/agents/runs/service";
import {
  abortRun,
  abortRunWith,
  isLeaseLost,
  isRunStopped,
  LeaseLostError,
  registerRunAbort,
  releaseRunAbort,
  RunStoppedError,
} from "@/lib/agents/runs/abort";
import { expireApprovalsForStoppedRun } from "@/lib/integrations/actions/gate";
import { getEnabledProjectSkills } from "@/lib/skills/service";
import { skillManifestSection } from "@/lib/skills/disclosure";
import { connectorChatTools } from "./connector-tools";
import { captureEpisode } from "@/lib/agents/learning/capture";
import {
  initialLoopState,
  isLoopState,
  loopLimitsFromEnv,
  runAgentLoop,
  STOPPED_TEXT,
  testsFailed,
  toolResultFor,
  type AgentLoopResult,
  type LoopState,
  type StreamGuard,
} from "@/lib/agents/loop";
import { prismaTranscriptStore } from "@/lib/agents/runs/transcript";
import { cancelAgentJobsForRun, enqueueAgentJob } from "@/lib/agents/queue/store";
import { inlineBudgetMs } from "@/lib/agents/queue/config";
// Phase 8: ship tools (git in the sandbox → push → PR) and recorded browser
// tools register themselves with the tool registry on import.
import "@/lib/ship/tools";
// Phase 9 (sites): site_checkout / site_publish_draft (registers on import).
import "@/lib/sites/tools";
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
  checkOutputAgainstRules,
  enforceStyleRules,
  loadActiveStyleRules,
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

export { DELEGATE_TOOL, type ChatToolCall } from "./tool-exec";

/** Thread messages (user + assistant text) a live turn sees as history. */
const HISTORY_MESSAGES = 20;

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
    "You can ACT on the user's project with your tools. Use read tools to ground your answers in real data; prefer a tool call over guessing. Independent reads can be called together in one turn.",
    grant
      ? `This task may only use these tool groups: ${grant.map((g) => TOOL_GROUP_LABELS[g]).join(", ")}. Calls outside them are refused.`
      : "",
    // Phase 9 (repos): the Operator in build mode follows the test-fix loop.
    turnMode(agentKey, grant) === "build" ? buildModeSystemPrompt(loopLimitsFromEnv().fixCycles) : "",
    "",
    "PROJECT CONTEXT:",
    projectContext,
    "",
    supplements,
    "",
    "RULES:",
    "- Never invent data: use tools for keywords, rankings, competitors, content, alerts, scores, workflows.",
    "- Tools marked as waiting for the user's OK are held behind a confirmation gate by the runtime — don't ask for confirmation yourself; call the tool and the system proposes it to the user.",
    "- When a task matches an available skill, call the load_skill tool with its slug BEFORE acting.",
    "- Connector tools (connector__<key>__<tool>) act in the user's connected apps; never put a credential in their arguments — the runtime injects it.",
    "- Keep summaries short and concrete: what you did, the key numbers, and what to look at next.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Milestone 21 (part C): enabled skill manifests (connector tools are native tools now). */
async function buildAgentSupplements(projectId: string): Promise<string> {
  const skills = await getEnabledProjectSkills(prisma, projectId).catch(() => []);
  return skillManifestSection(skills.map((s) => ({ name: s.name, description: s.description })));
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
// Live turns (Phase 8: the native agent loop)
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
  /** Phase 8: "build" runs the Operator on the code workload (default: from the grant). */
  mode?: "build" | "default";
  /** Phase 8: hand off to the worker at a step boundary after this (epoch ms). */
  handoffAt?: number;
  /** Phase 8: continue the run's saved transcript (the worker sets it). */
  resume?: boolean;
}

export interface AgentTurnOutput {
  assistantText: string;
  toolCalls: ChatToolCall[];
  threadTitle: string | null;
  /** Phase 5: true when the turn ended because the run was stopped. */
  cancelled?: boolean;
  /** Phase 5: true when the turn ended waiting for the user's "yes". */
  awaitingConfirmation?: boolean;
  /** Phase 8: the turn was handed to the agent worker and is still running. */
  queued?: boolean;
  /** Phase 8: the turn ended in an error (the run finishes `failed`). */
  failed?: boolean;
}

/** Phase 8: the Operator with the code group works in build mode (code workload). */
export function turnMode(agentKey: AgentKey, grant: readonly ToolGroup[] | null): "build" | "default" {
  return agentKey === "actor" && !!grant?.includes("code") ? "build" : "default";
}

/** The thread's recent user / assistant text, oldest first, without the current message. */
async function threadHistory(threadId: string, current: string): Promise<ChatMessage[]> {
  const rows = await prisma.aiChatMessage
    .findMany({
      where: { threadId, role: { in: ["user", "assistant"] } },
      orderBy: { createdAt: "desc" },
      take: HISTORY_MESSAGES + 1,
      select: { role: true, content: true },
    })
    .catch(() => []);
  if (rows[0]?.role === "user" && rows[0].content.trim() === current) rows.shift();
  const out: ChatMessage[] = rows
    .slice(0, HISTORY_MESSAGES)
    .reverse()
    .filter((r) => r.content.trim())
    .map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));
  while (out[0]?.role === "assistant") out.shift(); // the first message must be the user's
  return out;
}

/**
 * Phase 13B on the streaming path: block-severity BAN rules are checked
 * against the text as it streams, so a banned phrase never reaches the live
 * stream (require / disclaimer rules can only be judged on the final text,
 * which enforceStyleRules checks before delivery).
 */
async function styleStreamGuard(workspaceId: string): Promise<StreamGuard | undefined> {
  const rules = await loadActiveStyleRules(workspaceId).catch(() => []);
  const bans = rules.filter((r) => r.kind === "ban" && r.severity === "block");
  if (bans.length === 0) return undefined;
  return (text) => checkOutputAgainstRules(text, bans).violations.some((v) => v.severity === "block");
}

/** Phase 13B: fail-closed style-rule enforcement on the delivery path. */
async function enforceFinalText(text: string, workspaceId: string): Promise<string> {
  try {
    await enforceStyleRules(text, workspaceId);
    return text;
  } catch (err) {
    if (err instanceof StyleRuleBlockedError) {
      return (
        `I can't deliver that response as written — it violates your style ` +
        `rule${err.violations.length > 1 ? "s" : ""}: ` +
        err.violations.map((v) => `"${v.pattern}" (${v.kind})`).join(", ") +
        `. Adjust the request or the rule and try again.`
      );
    }
    // Infra failures in the checker degrade open so a broken style subsystem
    // can't take down the whole agent; rule-compile failures are contained
    // per-rule inside checkOutput.
    return text;
  }
}

/** Tool rows for the thread (executed calls, a sub-agent's included), in order. */
async function saveToolRows(threadId: string, calls: ChatToolCall[]): Promise<void> {
  for (const call of calls) {
    for (const d of call.delegated ?? []) {
      if (d.status === "executed") await saveMessage(threadId, "tool", d.resultSummary ?? "", [d]);
    }
    if (call.status === "executed") await saveMessage(threadId, "tool", call.resultSummary ?? "", [call]);
  }
}

/** Turn a finished loop into the turn's reply (style rules, rows, flags). */
async function finishLiveTurn(
  input: AgentTurnInput,
  loop: AgentLoopResult,
  extraCalls: ChatToolCall[] = [],
): Promise<AgentTurnOutput> {
  if (loop.status === "handoff") {
    return { assistantText: "", toolCalls: [...extraCalls, ...loop.calls], threadTitle: null, queued: true };
  }
  const cancelled = loop.status === "cancelled";
  let finalText = loop.finalText;
  if (!finalText) finalText = "I checked everything I could. Let me know if you'd like me to dig deeper.";
  if (!cancelled && loop.status !== "awaiting_confirmation") {
    finalText = await enforceFinalText(finalText, input.workspaceId);
  }
  const calls = [...extraCalls, ...loop.calls];
  await saveToolRows(input.threadId, loop.calls);
  await saveMessage(input.threadId, "assistant", finalText, calls);
  return {
    assistantText: finalText,
    toolCalls: calls,
    threadTitle: null,
    cancelled,
    awaitingConfirmation: loop.status === "awaiting_confirmation",
    failed: loop.status === "error",
  };
}

function loopContext(input: AgentTurnInput, confirmed = false): LoopContext {
  return {
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    role: input.role,
    confirmed,
    // Turn-scoped skill loading state (milestone 21): load_skill records slugs
    // here; the connector-tool declared-tool gate reads them.
    loadedSkills: new Set<string>(),
    agentKey: input.agentKey ?? "lead",
    grant: input.grant ?? null,
    runId: input.runId,
    signal: input.signal,
    threadId: input.threadId,
  };
}

/** Is a live model routed for this agent's workload? (else: mock mode) */
function agentIsLive(agentKey: AgentKey, mode: "build" | "default"): boolean {
  return getLlmProviderFor(workloadForAgent(agentKey, { mode })).isLive;
}

/** The system prompt + opening messages of a fresh live turn. */
async function freshTurnPrompt(input: AgentTurnInput, trimmed: string): Promise<{ system: string; messages: ChatMessage[] }> {
  const agentKey = input.agentKey ?? "lead";
  const grant = input.grant ?? null;
  const [projectContext, supplements, attachmentSection, intelligenceSection, history] = await Promise.all([
    buildProjectContext(input.projectId, input.workspaceId),
    buildAgentSupplements(input.projectId),
    buildAttachmentSection(input.projectId, input.threadId, input.attachmentIds),
    // Phase 13B: layered company intelligence (rules → voice → knowledge →
    // lessons/prefs → episodes); degrades to "" when the workspace has none.
    buildIntelligenceContext(input.workspaceId, trimmed).catch(() => ""),
    threadHistory(input.threadId, trimmed),
  ]);
  const system = systemPrompt(
    projectContext,
    [supplements, attachmentSection].filter(Boolean).join("\n\n"),
    intelligenceSection,
    agentKey,
    grant,
  );
  return { system, messages: [...history, { role: "user", content: trimmed }] };
}

/**
 * Phase 8: after the user's "yes", the confirmed calls ran; hand their real
 * results back into the transcript of the run that proposed them so the
 * model carries on from there. Null when that transcript is gone (or the
 * proposal came from a sub-agent, whose transcript is its own).
 */
async function continuationState(
  input: AgentTurnInput,
  done: Array<{ call: ChatToolCall; exec: ChatToolCall; result: Awaited<ReturnType<typeof executeTool>> }>,
): Promise<LoopState | null> {
  const runId = done[0]?.call.runId;
  if (!runId || done.some((d) => d.call.runId !== runId || !d.call.toolUseId)) return null;
  const saved = await prismaTranscriptStore.load(input.workspaceId, runId).catch(() => null);
  if (!isLoopState(saved)) return null;
  const last = saved.messages[saved.messages.length - 1];
  if (last?.role !== "user" || typeof last.content === "string") return null;
  const blocks = last.content;
  const maxChars = loopLimitsFromEnv().toolResultMaxChars;
  const patched = new Map<string, ChatToolResultBlock>();
  for (const d of done) patched.set(d.call.toolUseId!, toolResultFor(d.call.toolUseId!, d.exec, d.result, maxChars));
  if (![...patched.keys()].every((id) => blocks.some((b) => b.type === "tool_result" && b.toolUseId === id))) {
    return null;
  }
  const messages: ChatMessage[] = [
    ...saved.messages.slice(0, -1),
    {
      role: "user",
      content: blocks.map((b) =>
        b.type === "tool_result" && patched.has(b.toolUseId) ? patched.get(b.toolUseId)! : b,
      ),
    },
  ];
  const next = initialLoopState({ system: saved.system, messages, mode: saved.mode, workload: saved.workload });
  // Phase 9: the fix-cycle count survives an approval (run_checks / run_tests
  // ask first, so every cycle passes through here) — a confirmed failing
  // check is one more cycle.
  next.testFailCycles = (saved.testFailCycles ?? 0) + (done.some((d) => testsFailed(d.result ?? null)) ? 1 : 0);
  next.escalated = saved.escalated === true;
  return next;
}

export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnOutput> {
  const { projectId, threadId, userContent, attachmentIds } = input;
  const trimmed = userContent.trim();
  const agentKey: AgentKey = input.agentKey ?? "lead";
  const grant = input.grant ?? null;
  const mode = input.mode ?? turnMode(agentKey, grant);
  const turn: AgentTurnInput = { ...input, agentKey, grant, mode };
  const baseCtx = loopContext(turn);

  // 0. Phase 8: a worker picking the run up again continues its transcript.
  if (input.resume && input.runId) {
    const saved = await prismaTranscriptStore.load(input.workspaceId, input.runId).catch(() => null);
    if (isLoopState(saved)) {
      const loop = await runAgentLoop({
        ctx: baseCtx,
        state: saved,
        streamGuard: await styleStreamGuard(input.workspaceId),
        deps: { connectorTools: await connectorChatTools(projectId, grant).catch(() => []) },
      });
      return finishLiveTurn(turn, loop);
    }
  }

  // 1. Confirmation path: "yes" + a pending proposal → execute it.
  if (CONFIRM_RE.test(trimmed)) {
    const pending = await pendingProposal(threadId);
    if (pending?.length) {
      const executed: ChatToolCall[] = [];
      const done: Array<{ call: ChatToolCall; exec: ChatToolCall; result: Awaited<ReturnType<typeof executeTool>> }> = [];
      for (const call of pending) {
        // Phase 5: run as the agent that proposed it, inside the grant it
        // was proposed under — never wider than the thread's grant now.
        const callAgent = call.agentKey && isAgentKey(call.agentKey) ? call.agentKey : agentKey;
        const callGrant = call.grant
          ? (call.grant.filter((g) => !grant || grant.includes(g as ToolGroup)) as ToolGroup[])
          : grant;
        const ctx: LoopContext = { ...baseCtx, confirmed: true, agentKey: callAgent, grant: callGrant };
        const exec: ChatToolCall = { tool: call.tool, args: call.args, confirmed: true, status: "executed", agentKey: callAgent };
        const result = await executeTool(ctx, call.tool, call.args, exec);
        executed.push(exec);
        done.push({ call, exec, result });
        await saveMessage(threadId, "tool", exec.resultSummary ?? "", [exec]);
      }
      const cancelled = executed.some((c) => c.status === "cancelled");
      // Phase 8: the model carries on from the transcript that proposed it.
      if (!cancelled && agentIsLive(agentKey, mode)) {
        const state = await continuationState(turn, done).catch(() => null);
        if (state) {
          const loop = await runAgentLoop({
            ctx: baseCtx,
            state,
            handoffAt: input.handoffAt,
            streamGuard: await styleStreamGuard(input.workspaceId),
            deps: { connectorTools: await connectorChatTools(projectId, grant).catch(() => []) },
          });
          // The confirmed calls (already saved as tool rows) lead the reply's calls.
          return finishLiveTurn(turn, loop, executed);
        }
      }
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

  // 2. Mock mode: deterministic rule-based router.
  if (!agentIsLive(agentKey, mode)) {
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

  // 3. Live mode: the native agent loop.
  if (await stopRequested(baseCtx)) {
    await saveMessage(threadId, "assistant", STOPPED_TEXT, []);
    return { assistantText: STOPPED_TEXT, toolCalls: [], threadTitle: null, cancelled: true };
  }
  const prompt = await freshTurnPrompt(turn, trimmed);
  const loop = await runAgentLoop({
    ctx: baseCtx,
    system: prompt.system,
    messages: prompt.messages,
    mode,
    handoffAt: input.handoffAt,
    streamGuard: await styleStreamGuard(input.workspaceId),
    deps: { connectorTools: await connectorChatTools(projectId, grant).catch(() => []) },
  });
  return finishLiveTurn(turn, loop);
}

// ---------------------------------------------------------------------------
// Phase 5: hand a task to one sub-agent (the lead's delegate tool).
// ---------------------------------------------------------------------------

/** A child run already started for this tool call (a resumed parent reuses it). */
async function existingChildRun(workspaceId: string, parentRunId: string, toolUseId: string) {
  const { withWorkspaceScope } = await import("@/lib/substrate/memory/rls");
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.agentRun.findFirst({
      where: { workspaceId, parentRunId, agentState: { path: ["toolUseId"], equals: toolUseId } },
      select: { id: true, status: true },
    }),
  ).catch(() => null);
}

const delegate_to_subagent: ToolDef = {
  name: DELEGATE_TOOL,
  description:
    "Hand one focused piece of work to a sub-agent and get its result back. Use it when a task needs a specialist: agent is one of researcher, planner, drafter (Writer), analyst, scheduler, actor (Operator). The sub-agent works inside this task's tools (optionally fewer) and its write actions still wait for the user's OK.",
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
    const lctx = ctx as LoopContext;
    const threadId = lctx.threadId;

    // The child run: same workspace and thread, pointing at the lead's run.
    // A resumed lead (worker restart) picks up the child it already started.
    let childRunId: string | undefined;
    let resumeChild = false;
    if (ctx.runId) {
      const prior = lctx.toolUseId ? await existingChildRun(ctx.workspaceId, ctx.runId, lctx.toolUseId) : null;
      if (prior) {
        childRunId = prior.id;
        resumeChild = true;
      } else {
        const child = await createAgentRun({
          workspaceId: ctx.workspaceId,
          kind: "chat",
          startedBy: ctx.userId,
          threadId,
          agentKey: sub,
          parentRunId: ctx.runId,
          allowedTools: childGrant.groups,
          agentState: { task: task.slice(0, 500), projectId: ctx.projectId, ...(lctx.toolUseId ? { toolUseId: lctx.toolUseId } : {}) },
        });
        childRunId = child.id;
        await markAgentRunRunning(ctx.workspaceId, child.id);
        await runEvent(ctx, `Handed to ${name}: ${task.slice(0, 200)}`, { childRunId, agent: sub, grant: childGrant.groups }, "note");
      }
    }
    const childCtx: LoopContext = {
      ...lctx,
      confirmed: false,
      agentKey: sub,
      grant: childGrant.groups,
      runId: childRunId ?? ctx.runId,
      threadId,
      toolUseId: undefined,
    };

    let loop: AgentLoopResult | null = null;
    let finalText: string;
    try {
      if (!agentIsLive(sub, "default")) {
        finalText = `${name} needs a live model to work on its own; the hand-off was recorded.`;
      } else {
        const connectorTools = await connectorChatTools(ctx.projectId, childGrant.groups).catch(() => []);
        if (resumeChild && childRunId) {
          loop = await runAgentLoop({ ctx: childCtx, deps: { connectorTools } });
        } else {
          const [projectContext, supplements] = await Promise.all([
            buildProjectContext(ctx.projectId, ctx.workspaceId),
            buildAgentSupplements(ctx.projectId),
          ]);
          loop = await runAgentLoop({
            ctx: childCtx,
            system: systemPrompt(projectContext, supplements, "", sub, childGrant.groups),
            messages: [{ role: "user", content: task }],
            deps: { connectorTools },
          });
        }
        finalText = loop.finalText;
      }
    } catch (err) {
      if (childRunId) await finishAgentRun(ctx.workspaceId, childRunId, "failed").catch(() => undefined);
      throw err;
    }
    const cancelled = loop?.status === "cancelled";
    if (childRunId) {
      await finishAgentRun(
        ctx.workspaceId,
        childRunId,
        cancelled ? "cancelled" : loop?.status === "error" ? "failed" : "succeeded",
      ).catch(() => undefined);
    }
    const calls = (loop?.calls ?? []).map((c) => ({ ...c, agentKey: c.agentKey ?? sub }));
    const costMicroUsd = loop?.state.costMicroUsd ?? 0;
    if (cancelled) {
      // The whole task was stopped: stop the lead too.
      // (ctx is the lead's context here, so this asks about the lead's run.)
      if (await stopRequested(ctx)) throw new RunStoppedError();
      // Only this sub-agent was stopped (Runs page): the lead carries on.
      return {
        summary: `${name} was stopped before it finished.`,
        details: { subRunId: childRunId ?? null, agent: sub, grant: childGrant.groups, calls, stopped: true, costMicroUsd },
      };
    }
    const dropped = childGrant.dropped.length ? ` (not allowed: ${childGrant.dropped.join(", ")})` : "";
    return {
      summary: `${name}: ${finalText || "done"}${dropped}`.slice(0, 2000),
      details: { subRunId: childRunId ?? null, agent: sub, grant: childGrant.groups, calls, costMicroUsd },
    };
  },
};

registerExtraTool(delegate_to_subagent);
// Phase 8: the code tools (group "code"), run in the run's sandbox.
registerCodeTools();

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
  const grant = computeGrant({ agentKey, requested: t?.allowedTools ?? [] }).groups;
  // Phase 8: no sandbox provider → the code tools are off for this turn (the
  // model never sees tools that can only refuse, and the turn isn't build
  // mode). Delegated children inherit the narrowed grant.
  if (grant.includes("code")) {
    const avail = await sandboxAvailability().catch(() => ({ ok: false as const }));
    if (!avail.ok) return { agentKey, grant: grant.filter((g) => g !== "code") };
  }
  return { agentKey, grant };
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
  // Phase 8: a handed-off turn still waiting in the queue never starts; its
  // run ends here (a job a worker already holds stops at its next step).
  for (const id of stopped) {
    const n = await cancelAgentJobsForRun(input.workspaceId, id).catch(() => 0);
    if (n > 0) await finishAgentRun(input.workspaceId, id, "cancelled").catch(() => undefined);
  }
  await cancelPendingProposals(input.threadId).catch(() => undefined);
  if (stopped.length) await expireRunApprovals(input.workspaceId, stopped, input.userId);
  return stopped;
}

/** Payload of a `chat_turn` agent job (lib/agents/queue): everything a worker needs. */
export interface ChatTurnJobPayload {
  runId: string;
  projectId: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  threadId: string;
  userContent: string;
  attachmentIds?: string[];
  agentKey: AgentKey;
  grant: ToolGroup[];
  mode: "build" | "default";
}

export interface TrackedTurnOptions {
  capture?: typeof captureEpisode;
  /** Phase 8: inline time before hand-off (ms); null = never hand off. Default: env. */
  inlineBudgetMs?: number | null;
  /** Phase 8: told the run id as soon as the run exists (the SSE route tails it). */
  onRunCreated?: (runId: string) => void;
}

/** Finish a tracked turn's run from its outcome (shared by the request and the worker). */
async function settleTrackedRun(input: AgentTurnInput & { runId: string }, out: AgentTurnOutput): Promise<void> {
  if (out.cancelled) {
    await finishAgentRun(input.workspaceId, input.runId, "cancelled");
    await cancelPendingProposals(input.threadId).catch(() => undefined);
    await expireRunApprovals(input.workspaceId, [input.runId], input.userId);
    return;
  }
  if (out.awaitingConfirmation) {
    await appendAgentRunEvent(input.workspaceId, input.runId, {
      type: "gate",
      summary: "Waiting for your OK in the chat",
    }).catch(() => undefined);
  }
  await finishAgentRun(input.workspaceId, input.runId, out.failed ? "failed" : "succeeded");
}

/**
 * Phase 5: the turn entry point for request handlers. Records the turn as an
 * AgentRun (kind chat) running as the thread's agent inside its grant, wires
 * Stop to it, and finishes it as succeeded / failed / cancelled.
 *
 * Phase 8 hand-off rule: the turn runs in the request while it is short. A
 * turn still working after AGENT_INLINE_BUDGET_SECONDS (default 45) is handed
 * to the agent worker at its next step boundary — its transcript is already
 * saved, so the worker continues from that step — and the call returns
 * `queued: true` with the run id (the run keeps streaming its events; Stop
 * still works). A build-mode turn (the Operator with the code group) goes to
 * the worker before its first step: code work is long by nature. With
 * AGENT_WORKER=off nothing is handed off (every turn runs inline).
 */
export async function runTrackedAgentTurn(
  input: AgentTurnInput,
  opts: TrackedTurnOptions = {},
): Promise<AgentTurnOutput & { runId: string }> {
  const profile = await threadTaskProfile(input.threadId);
  const mode = input.mode ?? turnMode(profile.agentKey, profile.grant);
  const run = await createAgentRun({
    workspaceId: input.workspaceId,
    kind: "chat",
    startedBy: input.userId,
    threadId: input.threadId,
    agentKey: profile.agentKey,
    allowedTools: profile.grant,
    agentState: { projectId: input.projectId, prompt: input.userContent.slice(0, 280), mode },
  });
  await markAgentRunRunning(input.workspaceId, run.id);
  opts.onRunCreated?.(run.id);
  const budget = opts.inlineBudgetMs === undefined ? inlineBudgetMs() : opts.inlineBudgetMs;
  const tracked: AgentTurnInput & { runId: string } = {
    ...input,
    agentKey: profile.agentKey,
    grant: profile.grant,
    mode,
    runId: run.id,
  };
  const job: ChatTurnJobPayload = {
    runId: run.id,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    role: input.role,
    threadId: input.threadId,
    userContent: input.userContent,
    attachmentIds: input.attachmentIds,
    agentKey: profile.agentKey,
    grant: profile.grant,
    mode,
  };
  const queued = async (): Promise<AgentTurnOutput & { runId: string }> => {
    await enqueueAgentJob({ workspaceId: input.workspaceId, kind: "chat_turn", runId: run.id, payload: job });
    await appendAgentRunEvent(input.workspaceId, run.id, {
      type: "note",
      summary: "Handed to the agent worker; it keeps going in the background",
      payload: { kind: "handoff" },
    }).catch(() => undefined);
    return { assistantText: "", toolCalls: [], threadTitle: null, queued: true, runId: run.id };
  };

  // Build mode goes straight to the worker (a confirmation runs inline).
  if (budget !== null && (budget === 0 || mode === "build") && !CONFIRM_RE.test(input.userContent.trim())) {
    return queued();
  }

  const signal = registerRunAbort(run.id);
  try {
    const out = await runAgentTurnWithCapture(
      { ...tracked, signal, handoffAt: budget === null ? undefined : Date.now() + budget },
      opts,
    );
    if (out.queued) {
      const q = await queued();
      return { ...q, toolCalls: out.toolCalls };
    }
    await settleTrackedRun(tracked, out);
    return { ...out, runId: run.id };
  } catch (err) {
    await finishAgentRun(input.workspaceId, run.id, isRunStopped(err) ? "cancelled" : "failed").catch(() => undefined);
    throw err;
  } finally {
    releaseRunAbort(run.id);
  }
}

/**
 * Phase 8: the worker side of a handed-off turn (agent job `chat_turn`).
 * Continues the run's saved transcript (or starts the turn when it was
 * queued before its first step), then finishes the run exactly as the
 * request would have. Idempotent: a run that already finished is left alone.
 */
export async function continueTrackedAgentTurn(
  job: ChatTurnJobPayload,
  opts: { capture?: typeof captureEpisode; signal?: AbortSignal } = {},
): Promise<AgentTurnOutput & { runId: string }> {
  const run = await getAgentRun(job.workspaceId, job.runId);
  if (!run) throw new Error(`Run ${job.runId} not found in this workspace.`);
  const empty = { assistantText: "", toolCalls: [] as ChatToolCall[], threadTitle: null, runId: job.runId };
  if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") return empty;
  const tracked: AgentTurnInput & { runId: string } = { ...job, resume: true };
  const signal = registerRunAbort(job.runId);
  // The worker's lease signal: losing the lease stops the local work but
  // never finishes the run (the loop treats it as a hand-off).
  const onLeaseLost = () => abortRunWith(job.runId, new LeaseLostError());
  if (opts.signal?.aborted) onLeaseLost();
  opts.signal?.addEventListener("abort", onLeaseLost, { once: true });
  try {
    const out = await runAgentTurnWithCapture({ ...tracked, signal }, opts);
    if (out.queued || isLeaseLost(signal)) throw new LeaseLostError();
    await settleTrackedRun(tracked, out);
    return { ...out, runId: job.runId };
  } catch (err) {
    if (isLeaseLost(signal) || (err as { name?: unknown })?.name === "LeaseLostError") throw err;
    await finishAgentRun(job.workspaceId, job.runId, isRunStopped(err) ? "cancelled" : "failed").catch(() => undefined);
    throw err;
  } finally {
    opts.signal?.removeEventListener("abort", onLeaseLost);
    releaseRunAbort(job.runId);
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
