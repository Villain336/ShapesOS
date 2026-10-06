// ShapesOS — Phase 19A (WS=server): one cursor turn (the "brain").
//
//   transcript + screenshots (+ the ShapesOS UI map) → the vision model
//   through the router (workload "subagent": fast, vision-capable; the
//   workspace's own model key when it has one — BYOK, 0 credits) → streamed
//   text with POINT / DRAW / DICTATE tags, parsed server-side into events
//   (lib/cursor/tags.ts), plus tool calls that go through executeTool
//   EXACTLY like chat: reads run, everything else is held for the person's
//   OK and becomes a `proposal` (voiceApprovable = not Tier 3, not
//   destructive — lib/cursor/policy.ts).
//
// Screenshots live in this function's memory for this call only: they are
// never written to the run, its transcript, the audit or a log. The run
// timeline gets the words spoken, the reply text, what was pointed at and a
// ≤ 200-char text summary of what was on screen.
//
// Lineage: each conversation is one AgentRun of kind "cursor"
// (conversationId = its run id); utterances, points, proposals and actions
// are on its timeline and in the hash-chained authority audit.

import type { WorkspaceRole } from "@prisma/client";
import { roleAtLeast } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import type { ChatContentBlock, ChatMessage, ChatResponse, ChatToolDef, ChatToolResultBlock, ChatToolUseBlock, LlmProvider } from "@/lib/llm/types";
import { LlmProviderError } from "@/lib/llm/errors";
import { MockLlmProvider } from "@/lib/llm/mock";
import { getLlmProviderForWorkspace } from "@/lib/llm/workspace";
import { llmTokenCredits } from "@/lib/metering/credits";
import { allTools, getTool, toolAction, toolGroup } from "@/lib/chat/tools";
import { executeTool, isDelegationTool, type ChatToolCall } from "@/lib/chat/tool-exec";
import { AGENT_MAX_GROUPS, type ToolGroup } from "@/lib/agents/grants";
import { buildLoopTools, type LoopToolSet } from "@/lib/agents/loop-tools";
import { deferralFor, searchTools, SEARCH_TOOLS_DEF, SEARCH_TOOLS_TOOL } from "@/lib/agents/tool-loading";
import { appendAgentRunEvent, createAgentRun, finishAgentRun, markAgentRunRunning } from "@/lib/agents/runs/service";
import { authorityAudit } from "@/lib/authority/db";
import { CURSOR_SYSTEM_PROMPT, cursorUserTurn, screenSummary, type CursorTurnInput } from "./prompt";
import { CursorTagStream, type CursorScreen, type CursorTagEvent, type UiMapEntry } from "./tags";
import { cursorActionPolicy } from "./policy";
import { cursorMocksAllowed } from "@/lib/voice/stt";

/** Model calls per turn (tool lookups included). A turn is a short answer. */
export const CURSOR_MAX_STEPS = 4;
export const CURSOR_MAX_TOKENS = 1_024;
/** A proposal the person never decided expires (the card disappears). */
export const CURSOR_PROPOSAL_TTL_MS = 30 * 60_000;
/** Earlier turns of the conversation carried as text (never images). */
export const CURSOR_HISTORY_TURNS = 6;

export type CursorVisionProvider = "anthropic" | "openai" | "mock" | "none";

export type CursorSseEvent =
  | { event: "turn_started"; data: { runId: string; conversationId: string; mock?: true } }
  | { event: "text_delta"; data: { text: string } }
  | { event: "point"; data: Omit<Extract<CursorTagEvent, { type: "point" }>, "type"> }
  | { event: "draw"; data: Omit<Extract<CursorTagEvent, { type: "draw" }>, "type"> }
  | { event: "dictation"; data: { text: string } }
  | {
      event: "proposal";
      data: { approvalId: string; tool: string; summary: string; tier: 0 | 1 | 2 | 3; destructive: boolean; voiceApprovable: boolean; elementId?: string };
    }
  | { event: "agent_started"; data: { runId: string; maxUsd: number } }
  | { event: "error"; data: { code: string; message: string } }
  | { event: "done"; data: { usage: { credits: number; inputTokens: number; outputTokens: number } } };

export interface CursorCaller {
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
}

export interface CursorTurnRequest {
  conversationId?: string | null;
  transcript: string;
  screenshots: Array<CursorScreen & { jpegBase64: string }>;
  uiMap?: UiMapEntry[];
  app?: CursorTurnInput["app"];
  mode?: "answer" | "agent";
}

export interface CursorBrainDeps {
  /** Provider override (tests, the labelled mock). */
  provider?: LlmProvider;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

export class CursorTurnError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CursorTurnError";
  }
}

// ── the provider ────────────────────────────────────────────────────────────

/**
 * The labelled mock brain (ALLOW_FAKE_PROVIDERS=1 only): a scripted answer
 * that says it is a mock, points at the Approvals nav item when the page has
 * it (else the middle of the first screen), and proposes a draft when asked
 * to draft something / sending an invoice when asked to send one.
 */
export function cursorMockBrain(): MockLlmProvider {
  return new MockLlmProvider({
    chatScript: [
      (req) => {
        const last = req.messages[req.messages.length - 1];
        const blocks = typeof last?.content === "string" ? [{ type: "text" as const, text: last.content }] : (last?.content ?? []);
        if (blocks.some((b) => b.type === "tool_result")) {
          return { content: [{ type: "text", text: "Mock cursor: that is ready for you to approve on the card." }], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costMicroUsd: 0 };
        }
        const text = blocks.filter((b): b is Extract<ChatContentBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("\n");
        const said = /They said: "([\s\S]*)"\s*$/.exec(text)?.[1] ?? "";
        const shot = /Screenshot of screen(\d+)[^:]*: (\d+)×(\d+) pixels/.exec(text);
        const hasApprovals = text.includes("#nav:/dashboard/approvals ");
        const point = hasApprovals
          ? "[POINT:#nav:/dashboard/approvals:Approvals]"
          : shot
            ? `[POINT:${Math.round(Number(shot[2]) / 2)},${Math.round(Number(shot[3]) / 2)}:Here:screen${shot[1]}]`
            : "[POINT:none]";
        const content: ChatContentBlock[] = [{ type: "text", text: `Mock cursor: this is a scripted answer, no model was called. Look here ${point}.` }];
        const offered = new Set((req.tools ?? []).map((t) => t.name));
        if (/\bsend\b.*\binvoice\b/i.test(said) && offered.has("ops_send_invoice")) {
          content.push({ type: "tool_use", id: "mock_tu_invoice", name: "ops_send_invoice", input: { invoiceId: "mock-invoice" } });
        } else if (/\bdraft\b/i.test(said) && offered.has("create_content_draft")) {
          content.push({ type: "tool_use", id: "mock_tu_draft", name: "create_content_draft", input: { topic: said.slice(0, 80) || "mock draft" } });
        }
        return { content, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costMicroUsd: 0 };
      },
    ],
  });
}

function familyOfProvider(p: LlmProvider): CursorVisionProvider {
  if (!p.isLive) return "mock";
  return /anthropic/i.test(p.name) ? "anthropic" : "openai";
}

/** What the session reports for the brain (no network). */
export async function cursorVisionProvider(workspaceId: string, env: Record<string, string | undefined> = process.env): Promise<CursorVisionProvider> {
  const { resolveWorkloadForWorkspace } = await import("@/lib/llm/workspace");
  const r = await resolveWorkloadForWorkspace("subagent", workspaceId).catch(() => null);
  if (r?.provider.isLive) return familyOfProvider(r.provider);
  return cursorMocksAllowed(env) ? "mock" : "none";
}

async function brainProvider(caller: CursorCaller, runId: string, deps: CursorBrainDeps): Promise<{ provider: LlmProvider; byok: boolean; mock: boolean }> {
  if (deps.provider) return { provider: deps.provider, byok: false, mock: !deps.provider.isLive };
  const p = await getLlmProviderForWorkspace("subagent", { workspaceId: caller.workspaceId, actorId: caller.userId, runId, agentKey: "lead" });
  if (p.isLive) return { provider: p, byok: p.keySource === "workspace" || p.keySource === "self_host", mock: false };
  if (cursorMocksAllowed(deps.env ?? process.env)) return { provider: cursorMockBrain(), byok: false, mock: true };
  throw new CursorTurnError(503, "vision_not_configured", "The cursor's model is not configured on this server (set ANTHROPIC_API_KEY, or add your own model key in Settings → Providers).");
}

// ── the conversation run ────────────────────────────────────────────────────

/** The tool groups the cursor's brain may use (the lead's, minus hand-offs: agent mode is separate). */
export function cursorGrant(): ToolGroup[] {
  return AGENT_MAX_GROUPS.lead.filter((g) => g !== "delegate");
}

async function defaultProjectId(workspaceId: string): Promise<string> {
  const p = await prisma.project.findFirst({ where: { workspaceId }, orderBy: { updatedAt: "desc" }, select: { id: true } }).catch(() => null);
  return p?.id ?? "";
}

/** Open (or re-open) the conversation's run; refuses another person's run. */
export async function openCursorRun(caller: CursorCaller, conversationId: string | null | undefined, summary: string): Promise<{ runId: string; projectId: string }> {
  if (conversationId) {
    const run = await withWorkspaceScope(caller.workspaceId, (tx) =>
      tx.agentRun.findFirst({ where: { id: conversationId, workspaceId: caller.workspaceId }, select: { id: true, kind: true, startedBy: true, agentState: true } }),
    );
    if (!run || run.kind !== "cursor" || run.startedBy !== caller.userId) throw new CursorTurnError(404, "conversation_not_found", "That conversation was not found.");
    await markAgentRunRunning(caller.workspaceId, run.id);
    const projectId = ((run.agentState as { projectId?: unknown } | null)?.projectId as string | undefined) ?? (await defaultProjectId(caller.workspaceId));
    return { runId: run.id, projectId };
  }
  const projectId = await defaultProjectId(caller.workspaceId);
  const run = await createAgentRun({
    workspaceId: caller.workspaceId,
    kind: "cursor",
    startedBy: caller.userId,
    agentKey: "lead",
    allowedTools: cursorGrant(),
    agentState: { surface: "desktop", mode: "conversation", projectId, prompt: summary.slice(0, 280) },
  });
  await markAgentRunRunning(caller.workspaceId, run.id);
  return { runId: run.id, projectId };
}

async function history(workspaceId: string, runId: string): Promise<ChatMessage[]> {
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.agentRunEvent.findMany({
      where: { runId, workspaceId, type: "note", payload: { path: ["kind"], string_starts_with: "cursor_" } },
      orderBy: { seq: "desc" },
      take: CURSOR_HISTORY_TURNS * 2,
      select: { payload: true },
    }),
  ).catch(() => []);
  const out: ChatMessage[] = [];
  for (const r of rows.reverse()) {
    const p = r.payload as { kind?: string; text?: string } | null;
    if (!p?.text) continue;
    if (p.kind === "cursor_utterance") out.push({ role: "user", content: `(earlier) They said: "${p.text}"` });
    else if (p.kind === "cursor_reply") out.push({ role: "assistant", content: p.text });
  }
  // Keep strict user/assistant alternation, starting with a user turn.
  const merged: ChatMessage[] = [];
  for (const m of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) prev.content = `${prev.content as string}\n${m.content as string}`;
    else merged.push({ ...m });
  }
  while (merged[0]?.role === "assistant") merged.shift();
  if (merged[merged.length - 1]?.role === "user") merged.push({ role: "assistant", content: "(answered)" });
  return merged;
}

async function audit(workspaceId: string, actor: string, action: string, runId: string, detail: Record<string, unknown>): Promise<void> {
  await authorityAudit.logAsync({ workspaceId, actor, action, entityType: "cursor_run", entityId: runId, detail }).catch((err: unknown) => {
    console.warn(`[cursor] audit ${action} failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

// ── tools ───────────────────────────────────────────────────────────────────

function cursorToolSet(live: boolean): LoopToolSet {
  const base = {
    tools: allTools(),
    grant: cursorGrant() as readonly string[],
    groupOf: toolGroup,
    filter: (c: string) => !isDelegationTool(c),
  };
  const plain = buildLoopTools(base);
  // A live model gets the lead's core tools up front and finds the rest with
  // tool search (Phase 17 A2); the labelled mock is offered everything.
  const defer = live ? deferralFor({ agentKey: "lead", mode: "default", toolCount: plain.defs.length }) : null;
  return defer ? buildLoopTools({ ...base, defer }) : plain;
}

function summarizeArgs(args: Record<string, unknown>): string {
  const s = Object.entries(args)
    .slice(0, 4)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
}

/** Create the pending proposal row (tier etc. computed from the registry, never the model). */
async function createProposal(args: {
  caller: CursorCaller;
  runId: string;
  projectId: string;
  tool: string;
  input: Record<string, unknown>;
  elementId?: string;
  now: number;
}) {
  const def = getTool(args.tool);
  const policy = cursorActionPolicy({ tool: args.tool, description: def?.description ?? args.tool, kind: def?.kind ?? "publish", action: toolAction(args.tool) });
  const summary = `${args.tool.replace(/_/g, " ")}${Object.keys(args.input).length ? `: ${summarizeArgs(args.input)}` : ""}`.slice(0, 500);
  const row = await withWorkspaceScope(args.caller.workspaceId, (tx) =>
    tx.cursorProposal.create({
      data: {
        workspaceId: args.caller.workspaceId,
        runId: args.runId,
        userId: args.caller.userId,
        projectId: args.projectId || null,
        tool: args.tool,
        args: args.input as object,
        summary,
        tier: policy.tier,
        destructive: policy.destructive,
        voiceApprovable: policy.voiceApprovable,
        elementId: args.elementId ?? null,
        expiresAt: new Date(args.now + CURSOR_PROPOSAL_TTL_MS),
      },
      select: { id: true },
    }),
  );
  return { id: row.id, summary, policy };
}

// ── the turn ────────────────────────────────────────────────────────────────

export interface CursorTurnOutcome {
  runId: string;
  text: string;
  proposals: string[];
  usage: { credits: number; inputTokens: number; outputTokens: number };
}

/**
 * Run one turn, emitting contract events as they happen. Throws
 * CursorTurnError only before turn_started; afterwards failures are emitted
 * as `error` events and the turn still ends with `done`.
 */
export async function runCursorTurn(
  caller: CursorCaller,
  req: CursorTurnRequest,
  emit: (e: CursorSseEvent) => void,
  deps: CursorBrainDeps = {},
  signal?: AbortSignal,
): Promise<CursorTurnOutcome> {
  const now = deps.now ?? Date.now;
  const transcript = req.transcript.trim();
  const summary = screenSummary({ screens: req.screenshots, app: req.app, uiMap: req.uiMap });
  const { runId, projectId } = await openCursorRun(caller, req.conversationId, transcript);
  const { provider, byok, mock } = await brainProvider(caller, runId, deps).catch(async (err: unknown) => {
    await finishAgentRun(caller.workspaceId, runId, "failed").catch(() => undefined);
    throw err;
  });
  emit({ event: "turn_started", data: { runId, conversationId: runId, ...(mock ? { mock: true as const } : {}) } });

  // Earlier turns of this conversation (text only), read before this one is added.
  const earlier = req.mode === "agent" ? [] : await history(caller.workspaceId, runId);
  // The timeline: words and a text summary of the screen — never the image.
  await appendAgentRunEvent(caller.workspaceId, runId, {
    type: "note",
    summary: `They said: ${transcript}`.slice(0, 500),
    payload: { kind: "cursor_utterance", text: transcript.slice(0, 2000), screen: summary, screens: req.screenshots.length, app: req.app?.name ?? null },
  });

  // Agent mode: "do it in the background, max $3" → a capped background run.
  if (req.mode === "agent") return agentModeTurn(caller, runId, transcript, emit, summary);

  const canAct = roleAtLeast(caller.role, "editor");
  const tools = canAct ? cursorToolSet(provider.isLive) : null;
  const serverSearch = !!tools && provider.supportsToolSearch?.() === true;
  const activated = new Set<string>();
  const offered = () => {
    if (!tools) return undefined;
    const deferred = tools.defs.filter((d) => d.deferLoading);
    if (deferred.length === 0 || serverSearch) return tools.defs;
    const out: ChatToolDef[] = tools.defs.filter((d) => !d.deferLoading || activated.has(d.name)).map((d) => ({ ...d, deferLoading: undefined }));
    if (deferred.some((d) => !activated.has(d.name))) out.push(SEARCH_TOOLS_DEF);
    return out;
  };

  const elementIds = new Set((req.uiMap ?? []).map((e) => e.id));
  const tags = new CursorTagStream({ screens: req.screenshots, elementIds });
  const messages: ChatMessage[] = [
    ...earlier,
    { role: "user", content: cursorUserTurn({ transcript, screens: req.screenshots, uiMap: req.uiMap, app: req.app, mode: req.mode ?? "answer" }) },
  ];
  const usage = { credits: 0, inputTokens: 0, outputTokens: 0 };
  const points: string[] = [];
  const proposals: string[] = [];
  let lastElement: string | undefined;
  let spoken = "";
  let stepStart = false;

  const flushTags = (r: { text: string; events: CursorTagEvent[] }) => {
    if (r.text) {
      // A later step's words start a new sentence after the earlier ones.
      if (stepStart && spoken && !/\s$/.test(spoken) && !/^\s/.test(r.text)) r = { ...r, text: ` ${r.text}` };
      stepStart = false;
      spoken += r.text;
      emit({ event: "text_delta", data: { text: r.text } });
    }
    for (const ev of r.events) {
      if (ev.type === "point") {
        const data = Object.fromEntries(Object.entries(ev).filter(([k]) => k !== "type")) as Omit<typeof ev, "type">;
        if ("elementId" in ev) lastElement = ev.elementId;
        points.push(ev.label || ("elementId" in ev ? ev.elementId : `${ev.x},${ev.y}`));
        emit({ event: "point", data });
      } else if (ev.type === "draw") {
        const data = Object.fromEntries(Object.entries(ev).filter(([k]) => k !== "type")) as Omit<typeof ev, "type">;
        emit({ event: "draw", data });
      } else {
        emit({ event: "dictation", data: { text: ev.text } });
      }
    }
  };

  try {
    for (let step = 1; step <= CURSOR_MAX_STEPS; step++) {
      if (signal?.aborted) break;
      stepStart = step > 1;
      let final: ChatResponse | null = null;
      for await (const ev of provider.chatStream({
        system: [{ text: CURSOR_SYSTEM_PROMPT, cache: true }],
        messages: [...messages],
        tools: offered(),
        toolSearch: serverSearch,
        maxTokens: CURSOR_MAX_TOKENS,
        effort: "low",
        thinking: "off",
        cache: true,
        cacheTtl: "1h",
        signal,
        usage: { workspaceId: caller.workspaceId, actorId: caller.userId, runId, agentKey: "lead" },
      })) {
        if (ev.type === "text_delta") flushTags(tags.push(ev.text));
        else if (ev.type === "final") final = ev.response;
      }
      flushTags(tags.end());
      if (!final) break;
      usage.inputTokens += final.usage.inputTokens + final.usage.cacheReadTokens + final.usage.cacheWriteTokens;
      usage.outputTokens += final.usage.outputTokens;
      if (!byok && final.costMicroUsd) usage.credits += llmTokenCredits(final.costMicroUsd);
      if (final.content.length) messages.push({ role: "assistant", content: final.content });
      const uses = final.content.filter((b): b is ChatToolUseBlock => b.type === "tool_use");
      if (final.stopReason !== "tool_use" || uses.length === 0 || !tools) break;

      const results: ChatToolResultBlock[] = [];
      for (const u of uses) {
        const canonical = tools.toCanonical(u.name);
        if (u.invalid) {
          results.push({ type: "tool_result", toolUseId: u.id, content: `Not run: ${u.invalid}`, isError: true });
          continue;
        }
        if (canonical === SEARCH_TOOLS_TOOL) {
          const found = searchTools(tools.defs.filter((d) => d.deferLoading), String(u.input.query ?? ""), 5);
          for (const d of found) activated.add(d.name);
          results.push({ type: "tool_result", toolUseId: u.id, content: found.length ? found.map((d) => `- ${d.name}: ${d.description.slice(0, 200)}`).join("\n") : "No tools match." });
          continue;
        }
        const call: ChatToolCall = { tool: canonical, args: u.input, status: "error", toolUseId: u.id, runId };
        const ctx = { projectId, workspaceId: caller.workspaceId, userId: caller.userId, role: caller.role, confirmed: false, agentKey: "lead" as const, grant: cursorGrant(), runId, signal };
        const result = await executeTool(ctx, canonical, u.input, call);
        if (call.status === "pending_confirmation") {
          const p = await createProposal({ caller, runId, projectId, tool: canonical, input: u.input, elementId: lastElement, now: now() });
          proposals.push(p.id);
          emit({
            event: "proposal",
            data: { approvalId: p.id, tool: canonical, summary: p.summary, tier: p.policy.tier, destructive: p.policy.destructive, voiceApprovable: p.policy.voiceApprovable, ...(lastElement ? { elementId: lastElement } : {}) },
          });
          await appendAgentRunEvent(caller.workspaceId, runId, {
            type: "gate",
            summary: `Proposed ${canonical}: waiting for their OK${p.policy.voiceApprovable ? "" : " (click only)"}`.slice(0, 500),
            payload: { kind: "cursor_proposal", approvalId: p.id, tool: canonical, tier: p.policy.tier, destructive: p.policy.destructive, voiceApprovable: p.policy.voiceApprovable },
          }).catch(() => undefined);
          await audit(caller.workspaceId, caller.userId, "cursor.proposal", runId, { approvalId: p.id, tool: canonical, tier: p.policy.tier, destructive: p.policy.destructive, voiceApprovable: p.policy.voiceApprovable });
          results.push({
            type: "tool_result",
            toolUseId: u.id,
            content: `PROPOSED, NOT DONE: ${canonical} is waiting for the person to approve it on a card${p.policy.voiceApprovable ? " (they may say yes)" : " (they must click Approve; a spoken yes is not accepted)"}. Do not say it is done.`,
          });
        } else if (call.status === "executed") {
          const text = result?.summary ?? call.resultSummary ?? "done";
          if (getTool(canonical)?.kind !== "safe") {
            await audit(caller.workspaceId, caller.userId, "cursor.action", runId, { tool: canonical, autoApproved: call.autoApproved ?? null, summary: text.slice(0, 300) });
          }
          results.push({ type: "tool_result", toolUseId: u.id, content: `${text}${result?.details ? `\n${JSON.stringify(result.details).slice(0, 4000)}` : ""}` });
        } else {
          results.push({ type: "tool_result", toolUseId: u.id, content: call.resultSummary ?? `${canonical} did not run (${call.status}).`, isError: true });
        }
      }
      messages.push({ role: "user", content: results });
    }
  } catch (err) {
    const capped = err instanceof LlmProviderError && err.kind === "cap_exceeded";
    const msg = err instanceof Error ? err.message.replace(/^LLM request failed \[[^\]]*\]: /, "") : "The model call failed.";
    emit({ event: "error", data: { code: capped ? "cap_reached" : signal?.aborted ? "cancelled" : "model_error", message: msg.slice(0, 300) } });
    await appendAgentRunEvent(caller.workspaceId, runId, { type: "note", summary: `Cursor turn failed: ${msg}`.slice(0, 500), payload: { kind: "error" } }).catch(() => undefined);
  }

  const reply = spoken.replace(/[ \t]+\n/g, "\n").replace(/ +([.,!?;:])/g, "$1").trim();
  await appendAgentRunEvent(caller.workspaceId, runId, {
    type: "note",
    summary: (reply ? `Answered: ${reply}` : "No answer").slice(0, 500),
    payload: { kind: "cursor_reply", text: reply.slice(0, 2000), points: points.slice(0, 20), proposals },
  }).catch(() => undefined);
  await audit(caller.workspaceId, caller.userId, "cursor.turn", runId, {
    transcript: transcript.slice(0, 500),
    reply: reply.slice(0, 500),
    points: points.slice(0, 20),
    proposals,
    screen: summary,
    mock: mock || undefined,
  });
  await finishAgentRun(caller.workspaceId, runId, "succeeded").catch(() => undefined);
  emit({ event: "done", data: { usage } });
  return { runId, text: reply, proposals, usage };
}

async function agentModeTurn(
  caller: CursorCaller,
  runId: string,
  transcript: string,
  emit: (e: CursorSseEvent) => void,
  screen: string,
): Promise<CursorTurnOutcome> {
  const { spokenMaxUsd, startCursorAgent, CursorAgentError } = await import("./agent");
  const usage = { credits: 0, inputTokens: 0, outputTokens: 0 };
  const say = (text: string) => emit({ event: "text_delta", data: { text } });
  let reply = "";
  let agentRunId: string | null = null;
  const maxUsd = spokenMaxUsd(transcript);
  if (maxUsd === null) {
    reply = "How much may it spend? Say it again with a limit, for example max three dollars.";
    emit({ event: "error", data: { code: "max_usd_required", message: "Say a spending limit, for example max $3." } });
    say(reply);
  } else {
    try {
      const out = await startCursorAgent({ workspaceId: caller.workspaceId, userId: caller.userId, role: caller.role, goal: transcript, maxUsd, conversationId: runId });
      agentRunId = out.runId;
      emit({ event: "agent_started", data: { runId: out.runId, maxUsd: out.maxUsd } });
      reply = `Started in the background with a $${out.maxUsd.toFixed(2)} limit. I'll tell you when it's done.`;
      say(reply);
    } catch (err) {
      const e = err instanceof CursorAgentError ? err : null;
      reply = e?.message ?? "I couldn't start that in the background.";
      emit({ event: "error", data: { code: e?.code ?? "agent_error", message: reply } });
      say(reply);
    }
  }
  await appendAgentRunEvent(caller.workspaceId, runId, {
    type: "note",
    summary: `Answered: ${reply}`.slice(0, 500),
    payload: { kind: "cursor_reply", text: reply, agentRunId },
  }).catch(() => undefined);
  await audit(caller.workspaceId, caller.userId, "cursor.turn", runId, { transcript: transcript.slice(0, 500), reply, agentRunId, screen });
  await finishAgentRun(caller.workspaceId, runId, "succeeded").catch(() => undefined);
  emit({ event: "done", data: { usage } });
  return { runId, text: reply, proposals: [], usage };
}
