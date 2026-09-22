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

import { prisma } from "@/lib/prisma";
import type { WorkspaceRole } from "@prisma/client";
import { roleAtLeast } from "@/lib/authz";
import { getLlmProvider, llmStatus } from "@/lib/llm";
import { TOOLS, getTool, toolCatalogForPrompt, type ToolContext, type ToolDef } from "./tools";
import { getEnabledProjectSkills } from "@/lib/skills/service";
import { skillManifestSection } from "@/lib/skills/disclosure";
import { connectorToolsSection, resolveConnectorTool } from "./connector-tools";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MAX_ITERATIONS = 6;

export interface ChatToolCall {
  tool: string;
  args: Record<string, unknown>;
  resultSummary?: string;
  status: "executed" | "pending_confirmation" | "error" | "skipped_role";
  confirmed?: boolean;
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
      prisma.project.findUnique({ where: { id: projectId }, select: { domain: true, locale: true } }),
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

function systemPrompt(projectContext: string, mockMode: boolean, supplements: string): string {
  return [
    "You are Marketr, an expert SEO strategist embedded in the user's marketing workspace.",
    "You can ACT on the user's project using the tools below. Use read tools to ground your answers in real data; prefer a tool call over guessing.",
    "",
    "PROJECT CONTEXT:",
    projectContext,
    "",
    supplements,
    "",
    "TOOLS:",
    toolCatalogForPrompt(),
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
): Promise<string> {
  const [skills, connectors] = await Promise.all([
    getEnabledProjectSkills(prisma, projectId).catch(() => []),
    connectorToolsSection(projectId).catch(() => "## CONNECTOR TOOLS\n\nUnavailable."),
  ]);
  return [
    skillManifestSection(skills.map((s) => ({ name: s.name, description: s.description }))),
    "",
    connectors,
  ].join("\n");
}

const ATTACHMENT_TEXT_CAP = 50 * 1024;

function readAttachmentText(storagePath: string, mimeType: string | null): string {
  const abs = join(process.cwd(), storagePath);
  if (!existsSync(abs)) return "[file missing from disk]";
  const textLike =
    (mimeType ?? "").startsWith("text/") ||
    ["application/json", "application/csv", "application/xml", "application/javascript", "application/typescript"].includes(mimeType ?? "");
  if (!textLike) return "[binary file — not readable as text]";
  const buf = readFileSync(abs);
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
  const parts = rows.map((r) => {
    if (r.source === "upload" && r.storagePath) {
      return `- ${r.filename} (${r.mimeType ?? "unknown type"}):\n${readAttachmentText(r.storagePath, r.mimeType)}`;
    }
    if (r.source === "connector") {
      return `- ${r.filename} (via connector ${r.connectorKey ?? "unknown"}: ${r.externalRef ?? "no reference"})`;
    }
    return `- ${r.filename}`;
  });
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
): Promise<void> {
  await prisma.fileChangeLog
    .create({
      data: {
        projectId: ctx.projectId,
        workspaceId: ctx.workspaceId,
        filePath: `chat:${tool.name}:${ctx.projectId}`,
        actor: "ai",
        action: ctx.confirmed ? "ai_applied" : "ai_proposal",
        summary: `[${tool.kind}] ${tool.name}: ${summary}`.slice(0, 500),
        approvedBy: ctx.confirmed ? ctx.userId : null,
      },
    })
    .catch(() => {});
}

async function executeTool(
  ctx: ToolContext,
  toolName: string,
  args: Record<string, unknown>,
  call: ChatToolCall,
): Promise<void> {
  const tool = getTool(toolName);
  if (!tool) {
    // Dynamic connector tools (milestone 21): connector.<key>.<toolName>.
    if (toolName.startsWith("connector.")) {
      const outcome = await resolveConnectorTool(toolName, ctx, args);
      call.status = outcome.status;
      call.resultSummary = outcome.resultSummary;
      return;
    }
    call.status = "error";
    call.resultSummary = `Unknown tool "${toolName}". Available: ${TOOLS.map((t) => t.name).join(", ")}`;
    return;
  }
  if (!roleAtLeast(ctx.role, tool.minRole)) {
    call.status = "skipped_role";
    call.resultSummary = `Tool "${toolName}" needs the ${tool.minRole} role (you have ${ctx.role}).`;
    return;
  }
  // Confirmation gate: non-safe tools only run after an explicit "yes".
  if (tool.kind !== "safe" && !ctx.confirmed) {
    call.status = "pending_confirmation";
    call.resultSummary = `Proposed ${tool.name} (${tool.kind}) — awaiting confirmation`;
    return;
  }
  try {
    const result = await tool.execute(ctx, args);
    call.status = "executed";
    call.resultSummary = result.summary;
    await auditToolExecution(ctx, tool, result.summary);
  } catch (err) {
    call.status = "error";
    call.resultSummary = err instanceof Error ? err.message : `${toolName} failed`;
    await auditToolExecution(ctx, tool, `FAILED: ${call.resultSummary}`);
  }
}

function proposalText(call: ChatToolCall): string {
  const tool = getTool(call.tool);
  const kind = tool?.kind ?? "write";
  const args = Object.entries(call.args)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
  return [
    `I'd like to run **${call.tool}** (${kind} action)${args ? ` with ${args}` : ""}.`,
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
          "I can read your Marketr project and take actions in it. In mock mode (no LLM key) I work from slash commands:",
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

async function pendingProposal(threadId: string): Promise<ChatToolCall[] | null> {
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
}

export interface AgentTurnOutput {
  assistantText: string;
  toolCalls: ChatToolCall[];
  threadTitle: string | null;
}

export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnOutput> {
  const { projectId, workspaceId, userId, role, threadId, userContent, attachmentIds } = input;
  const trimmed = userContent.trim();

  // Turn-scoped skill loading state (milestone 21): load_skill records slugs
  // here; the connector-tool declared-tool gate reads them.
  const loadedSkills = new Set<string>();

  // 1. Confirmation path: "yes" + a pending proposal → execute it.
  if (CONFIRM_RE.test(trimmed)) {
    const pending = await pendingProposal(threadId);
    if (pending?.length) {
      const ctx: ToolContext = { projectId, workspaceId, userId, role, confirmed: true, loadedSkills };
      const executed: ChatToolCall[] = [];
      for (const call of pending) {
        const exec: ChatToolCall = { tool: call.tool, args: call.args, confirmed: true, status: "executed" };
        await executeTool(ctx, call.tool, call.args, exec);
        executed.push(exec);
        await saveMessage(threadId, "tool", exec.resultSummary ?? "", [exec]);
      }
      const failures = executed.filter((c) => c.status !== "executed");
      const text =
        failures.length === 0
          ? `Done. ${executed.map((c) => c.resultSummary).join(" ")}`
          : `Partially done. ${executed.map((c) => (c.status === "executed" ? `✔ ${c.resultSummary}` : `✘ ${c.tool}: ${c.resultSummary}`)).join("\n")}`;
      await saveMessage(threadId, "assistant", text, executed);
      return { assistantText: text, toolCalls: executed, threadTitle: null };
    }
    // "yes" with nothing pending — fall through to a normal turn.
  }

  const isLive = llmStatus().isLive;

  // 2. Mock mode: deterministic rule-based router.
  if (!isLive) {
    const ctx: ToolContext = { projectId, workspaceId, userId, role, confirmed: false, loadedSkills };
    // Attachments still bind to the thread in mock mode.
    await buildAttachmentSection(projectId, threadId, attachmentIds);
    const { text, toolCalls } = await mockTurn(ctx, trimmed);
    // Persist tool messages for executed reads (mirrors live mode).
    for (const call of toolCalls) {
      if (call.status === "executed") {
        await saveMessage(threadId, "tool", call.resultSummary ?? "", [call]);
      }
    }
    await saveMessage(threadId, "assistant", text, toolCalls);
    return { assistantText: text, toolCalls, threadTitle: null };
  }

  // 3. Live mode: prompt-engineered agent loop.
  const ctx: ToolContext = { projectId, workspaceId, userId, role, confirmed: false, loadedSkills };
  const [projectContext, supplements, attachmentSection] = await Promise.all([
    buildProjectContext(projectId, workspaceId),
    buildAgentSupplements(projectId, workspaceId),
    buildAttachmentSection(projectId, threadId, attachmentIds),
  ]);
  const sys = systemPrompt(
    projectContext,
    false,
    [supplements, attachmentSection].filter(Boolean).join("\n\n"),
  );
  const llm = getLlmProvider();

  const transcript: Array<{ role: "user" | "assistant"; content: string }> = [
    { role: "user", content: trimmed },
  ];
  const turnCalls: ChatToolCall[] = [];
  let finalText = "";

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const prompt = [
      sys,
      "",
      "CONVERSATION:",
      ...transcript.map((m) => `${m.role === "user" ? "USER" : "ASSISTANT"}: ${m.content}`),
      "ASSISTANT:",
    ].join("\n");

    let response: string;
    try {
      response = await llm.generate(prompt);
    } catch (err) {
      finalText = `The AI provider failed: ${err instanceof Error ? err.message : "unknown error"}. Try again, or use slash commands in mock mode.`;
      break;
    }

    const parsed = parseToolCalls(response);
    if (!parsed.ok || parsed.calls.length === 0) {
      finalText = parsed.ok ? response.trim() : response.trim();
      break;
    }

    // Execute the tool calls.
    const iterationCalls: ChatToolCall[] = parsed.calls.map((c) => ({
      tool: c.tool,
      args: c.args,
      status: "executed" as const,
    }));
    const results: string[] = [];
    let hitProposal = false;
    for (const call of iterationCalls) {
      await executeTool(ctx, call.tool, call.args, call);
      turnCalls.push(call);
      if (call.status === "executed") {
        await saveMessage(threadId, "tool", call.resultSummary ?? "", [call]);
        results.push(`TOOL RESULT (${call.tool}): ${call.resultSummary}`);
      } else if (call.status === "pending_confirmation") {
        hitProposal = true;
        results.push(`TOOL PROPOSED (${call.tool}) — needs user confirmation, do NOT execute yet.`);
      } else {
        results.push(`TOOL ${call.status.toUpperCase()} (${call.tool}): ${call.resultSummary}`);
      }
    }
    transcript.push({ role: "assistant", content: response.trim() });
    transcript.push({ role: "user", content: results.join("\n") });

    if (hitProposal) {
      // Propose the FIRST pending action to the user and stop the loop.
      const proposal = iterationCalls.find((c) => c.status === "pending_confirmation");
      finalText = proposal ? proposalText(proposal) : "I need your confirmation before proceeding.";
      // Mark the remaining calls as skipped so nothing leaks through later.
      for (const c of iterationCalls) {
        if (c.status === "pending_confirmation" && c !== proposal) c.status = "error";
      }
      break;
    }
  }

  if (!finalText) {
    finalText = "I checked everything I could. Let me know if you'd like me to dig deeper.";
  }
  await saveMessage(threadId, "assistant", finalText, turnCalls);
  return { assistantText: finalText, toolCalls: turnCalls, threadTitle: null };
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
