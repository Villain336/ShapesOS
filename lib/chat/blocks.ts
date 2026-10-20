// ShapesOS — Phase 22 (chat): the transcript BLOCK MODEL (PURE: no React,
// no prisma, no DOM).
//
// The chat renders a Claude Code-style stream of blocks in one column:
//   user · text (markdown) · thinking · tool (call + typed result) ·
//   approval (held calls, decided inline) · genui (OpenUI Lang program) ·
//   delegation (sub-agents working) · notice (errors, stops, decisions).
//
// Two producers feed ONE model, so a reloaded thread looks like the live one:
//   * foldBlockFrame(): every AG-UI frame of a live turn (TOOL_CALL_*,
//     TEXT_MESSAGE_*, STATE_*, CUSTOM marketr.*) — tolerant of out-of-order
//     and resumed streams (a re-announced call or re-sent text never makes a
//     second block);
//   * blocksFromThread(): the persisted AiChatMessage rows (user / assistant /
//     tool, with the ChatToolCall JSON) — a confirmed call that is saved as a
//     `tool` row AND leads the reply's toolCalls renders ONCE (the
//     duplicate-chip bug), keyed by toolUseId when present.
//
// Tool blocks are keyed by the model's tool_use id (metadata.marketr.toolUseId)
// when the server sends it, else by the AG-UI toolCallId, so the confirmed
// execution of a held call (a later stream, a new AG-UI run id) fills the
// block that proposed it.

import type { ChatToolCall } from "./tool-exec";
import { CACHED_ANSWER_TOOL, CHAT_DECISION_TOOL, RENDER_UI_TOOL, isToolUiHint, type ToolUiHint } from "./ui-hints";

export { CACHED_ANSWER_TOOL, CHAT_DECISION_TOOL, RENDER_UI_TOOL, isToolUiHint, TOOL_UI_HINTS, type ToolUiHint } from "./ui-hints";

export type ToolBlockStatus = "running" | ChatToolCall["status"];

export type ApprovalDecision = "pending" | "approved" | "denied" | "edited";

/** One held call waiting for the person (marketr.toolProposal / a pending ChatToolCall). */
export interface ApprovalItem {
  toolCallId: string;
  toolUseId: string | null;
  tool: string;
  args: Record<string, unknown>;
  toolKind: string | null;
  /** Phase 14 tier when known (3 = money / irreversible: a click is required). */
  tier: 0 | 1 | 2 | 3 | null;
  /** True when a typed or spoken "yes" is refused (Tier 3 / destructive). */
  needsClick: boolean;
  /** The automation action a rule could cover ("do this without asking"), Tier 0–2 only. */
  autoAction?: string;
  agentKey?: string;
  /** The agent run that proposed it (the decision resumes it). */
  runId?: string;
  decision: ApprovalDecision;
  /** The proposal's one-line description (the old prose), for the card body. */
  summary?: string;
}

export interface DelegationRef {
  parentRunId: string;
  planId: string;
  tasks: number;
  goal: string;
}

export type ChatBlock =
  | { kind: "user"; id: string; text: string; createdAt?: string; messageId?: string }
  | { kind: "text"; id: string; text: string; streaming: boolean; cached?: boolean; createdAt?: string; messageId?: string }
  | { kind: "thinking"; id: string; active: boolean; text?: string }
  | {
      kind: "tool";
      id: string;
      toolCallId: string;
      toolUseId: string | null;
      tool: string;
      /** The raw argument text as it streams (JSON). */
      argsText: string;
      /** Parsed arguments once the text parses (null while streaming an incomplete object). */
      args: Record<string, unknown> | null;
      argsComplete: boolean;
      status: ToolBlockStatus;
      resultText: string | null;
      ui: ToolUiHint | null;
      /** The structured payload the typed renderer reads (capped by the server). */
      payload: unknown;
      confirmed?: boolean;
      autoApproved?: string;
      cached?: boolean;
      agentKey?: string;
      /** The agent run that recorded it (persisted rows). */
      runId?: string;
      /** Phase 14 tier of a held call, when known. */
      tier?: 0 | 1 | 2 | 3;
      toolKind?: string;
      messageId?: string;
      createdAt?: string;
    }
  | { kind: "approval"; id: string; items: ApprovalItem[]; messageId?: string }
  | {
      kind: "genui";
      id: string;
      toolCallId: string;
      toolUseId: string | null;
      /** The OpenUI Lang program (streams in with the tool's arguments). */
      program: string;
      streaming: boolean;
      status: ToolBlockStatus;
      resultText: string | null;
      /** Form / $variable state the person left on it (persisted on the message). */
      uiState?: Record<string, unknown>;
      messageId?: string;
      createdAt?: string;
    }
  | { kind: "delegation"; id: string; parentRunId: string; planId: string; tasks: number; goal: string; messageId?: string }
  | { kind: "notice"; id: string; text: string; tone: "info" | "error" | "stopped" | "decision"; messageId?: string; createdAt?: string };


/** The live fold of one (or several chained) turns. */
export interface BlockFold {
  blocks: ChatBlock[];
  /** RUN_STARTED arrived. */
  started: boolean;
  /** RUN_FINISHED / RUN_ERROR arrived. */
  done: boolean;
  error: string | null;
  /** The turn ended with proposals waiting for a decision. */
  awaiting: boolean;
  queued: boolean;
  cached: boolean;
  /** CoAgents shared state (STATE_SNAPSHOT + STATE_DELTA patches). */
  sharedState: Record<string, unknown> | null;
  /** Tool index: toolUseId or toolCallId → block id. */
  toolIndex: Record<string, string>;
  /** AG-UI toolCallId → toolUseId once known. */
  callToUse: Record<string, string>;
  openMessageId: string | null;
  /** The approval block of the turn in progress (new tool blocks go before it). */
  openApprovalId: string | null;
  seq: number;
}

export function emptyBlockFold(): BlockFold {
  return {
    blocks: [],
    started: false,
    done: false,
    error: null,
    awaiting: false,
    queued: false,
    cached: false,
    sharedState: null,
    toolIndex: {},
    callToUse: {},
    openMessageId: null,
    openApprovalId: null,
    seq: 0,
  };
}

/** The frames the fold reads (a superset of components/chat/agui-stream's AguiFrame). */
export interface BlockFrame {
  type: string;
  messageId?: string;
  delta?: unknown;
  message?: string;
  toolCallId?: string;
  toolCallName?: string;
  content?: string;
  name?: string;
  value?: unknown;
  snapshot?: unknown;
  metadata?: { marketr?: Record<string, unknown> } | Record<string, unknown>;
}

type ToolBlock = Extract<ChatBlock, { kind: "tool" }>;
type GenUiBlock = Extract<ChatBlock, { kind: "genui" }>;
type TextBlock = Extract<ChatBlock, { kind: "text" }>;
type ApprovalBlock = Extract<ChatBlock, { kind: "approval" }>;

const TOOL_STATUSES: readonly string[] = ["executed", "pending_confirmation", "error", "skipped_role", "denied", "cancelled"];

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function tierOf(v: unknown): 0 | 1 | 2 | 3 | null {
  return v === 0 || v === 1 || v === 2 || v === 3 ? v : null;
}

/** Parse the streamed argument text when it is a complete JSON object. */
export function parseArgsText(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!t.startsWith("{")) return null;
  try {
    const v = JSON.parse(t) as unknown;
    return rec(v);
  } catch {
    return null;
  }
}

/**
 * The value of one string property while its JSON object is still streaming
 * (render_ui's `program`): `{"program":"root = Ta` → `root = Ta`. Escapes are
 * decoded; the text after the last complete escape is held back.
 */
export function partialStringProp(text: string, prop: string): string {
  const complete = parseArgsText(text);
  if (complete) return typeof complete[prop] === "string" ? (complete[prop] as string) : "";
  const key = JSON.stringify(prop);
  const at = text.indexOf(key);
  if (at < 0) return "";
  let i = at + key.length;
  while (i < text.length && /[\s:]/.test(text[i]!)) i++;
  if (text[i] !== '"') return "";
  i++;
  let out = "";
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') break;
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === undefined) break;
      if (next === "u") {
        const hex = text.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 6;
        continue;
      }
      out += next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * The pre-Phase-22 confirmation prose ("I'd like to run **x** … Reply yes"):
 * the approval block replaces it, so the transcript hides it when a proposal
 * of the same turn is on screen.
 */
export function isProposalText(text: string): boolean {
  const t = text.trim();
  return (
    /^(I'd like|The .{1,60} sub-agent would like) to run \*\*/.test(t) ||
    /^\d+ actions are waiting for your OK:/.test(t) ||
    /^Still waiting for your OK:/.test(t) ||
    /\n\nStill waiting for your OK:/.test(t)
  );
}

function marketrOf(frame: BlockFrame): Record<string, unknown> {
  const m = frame.metadata as { marketr?: unknown } | undefined;
  return rec(m?.marketr) ?? {};
}

function nextId(s: BlockFold, prefix: string): string {
  s.seq += 1;
  return `${prefix}-${s.seq}`;
}

function clone(s: BlockFold): BlockFold {
  return { ...s, blocks: [...s.blocks], toolIndex: { ...s.toolIndex }, callToUse: { ...s.callToUse } };
}

function findBlockIndex(s: BlockFold, key: string | undefined): number {
  if (!key) return -1;
  const id = s.toolIndex[key];
  if (!id) return -1;
  return s.blocks.findIndex((b) => b.id === id);
}

/** The live adapter's call id is `<aguiRunId>:tool:<toolUseId>`; the model's id is the stable key across streams. */
function useIdFromCallId(toolCallId: string | undefined): string | undefined {
  const m = toolCallId ? /:tool:([^:]+)$/.exec(toolCallId) : null;
  return m?.[1];
}

function lookupTool(s: BlockFold, toolCallId: string | undefined, toolUseId: string | undefined): number {
  const byUse = findBlockIndex(s, toolUseId ?? (toolCallId ? s.callToUse[toolCallId] : undefined));
  if (byUse >= 0) return byUse;
  return findBlockIndex(s, toolCallId);
}

function indexTool(s: BlockFold, block: ToolBlock | GenUiBlock, toolUseId?: string): void {
  s.toolIndex[block.toolCallId] = block.id;
  const use = toolUseId ?? block.toolUseId ?? undefined;
  if (use) {
    s.toolIndex[use] = block.id;
    s.callToUse[block.toolCallId] = use;
    block.toolUseId = use;
  }
}

function openTool(s: BlockFold, toolCallId: string, tool: string, toolUseIdIn?: string): number {
  const toolUseId = toolUseIdIn ?? useIdFromCallId(toolCallId);
  const existing = lookupTool(s, toolCallId, toolUseId);
  if (existing >= 0) {
    const b = s.blocks[existing]!;
    if (b.kind === "tool" || b.kind === "genui") {
      // The same call announced on a later stream (a decision's continuation): re-key it;
      // a RESULT that came first left a placeholder name and no toolUseId: fill them.
      const next = { ...b, toolCallId, ...(b.kind === "tool" && b.tool === PLACEHOLDER_TOOL && tool !== PLACEHOLDER_TOOL ? { tool } : {}) } as typeof b;
      s.blocks[existing] = next;
      indexTool(s, next, toolUseId);
    }
    return existing;
  }
  const block: ToolBlock | GenUiBlock =
    tool === RENDER_UI_TOOL
      ? { kind: "genui", id: nextId(s, "genui"), toolCallId, toolUseId: toolUseId ?? null, program: "", streaming: true, status: "running", resultText: null }
      : {
          kind: "tool",
          id: nextId(s, "tool"),
          toolCallId,
          toolUseId: toolUseId ?? null,
          tool,
          argsText: "",
          args: null,
          argsComplete: false,
          status: "running",
          resultText: null,
          ui: null,
          payload: null,
        };
  // The turn's approval block stays last: a later call of the same step goes before it.
  const open = s.openApprovalId ? s.blocks.findIndex((b) => b.id === s.openApprovalId) : -1;
  if (open >= 0) s.blocks.splice(open, 0, block);
  else s.blocks.push(block);
  indexTool(s, block, toolUseId);
  return open >= 0 ? open : s.blocks.length - 1;
}

const PLACEHOLDER_TOOL = "tool";

function currentApproval(s: BlockFold): ApprovalBlock {
  const open = s.openApprovalId ? s.blocks.find((b) => b.id === s.openApprovalId) : undefined;
  if (open?.kind === "approval") return open;
  const block: ApprovalBlock = { kind: "approval", id: nextId(s, "approval"), items: [] };
  s.blocks.push(block);
  s.openApprovalId = block.id;
  return block;
}

function settleApproval(s: BlockFold, toolUseId: string | null, toolCallId: string, decision: ApprovalDecision): void {
  for (let i = 0; i < s.blocks.length; i++) {
    const b = s.blocks[i]!;
    if (b.kind !== "approval") continue;
    const hit = b.items.findIndex((it) => (toolUseId && it.toolUseId === toolUseId) || it.toolCallId === toolCallId);
    if (hit < 0) continue;
    const items = b.items.map((it, j) => (j === hit ? { ...it, decision } : it));
    s.blocks[i] = { ...b, items };
  }
  s.awaiting = s.blocks.some((b) => b.kind === "approval" && b.items.some((it) => it.decision === "pending"));
}

/** JSON Patch (RFC 6902) subset: add / replace / remove on object paths. */
export function applyJsonPatch(doc: Record<string, unknown> | null, patch: unknown): Record<string, unknown> | null {
  if (!Array.isArray(patch)) return doc;
  let out: Record<string, unknown> = structuredClone(doc ?? {});
  for (const op of patch) {
    const o = rec(op);
    if (!o || typeof o.path !== "string") continue;
    const parts = o.path.split("/").slice(1).map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
    if (parts.length === 0) {
      if (o.op === "replace" || o.op === "add") out = (rec(o.value) ?? {}) as Record<string, unknown>;
      continue;
    }
    let cur: Record<string, unknown> | unknown[] = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i]!;
      const nextVal = Array.isArray(cur) ? cur[Number(key)] : cur[key];
      if (nextVal === undefined || nextVal === null || typeof nextVal !== "object") {
        if (o.op === "remove") {
          cur = null as never;
          break;
        }
        const made: Record<string, unknown> = {};
        if (Array.isArray(cur)) cur[Number(key)] = made;
        else cur[key] = made;
        cur = made;
      } else {
        cur = nextVal as Record<string, unknown> | unknown[];
      }
    }
    if (!cur) continue;
    const last = parts[parts.length - 1]!;
    if (Array.isArray(cur)) {
      const idx = last === "-" ? cur.length : Number(last);
      if (o.op === "remove") cur.splice(idx, 1);
      else if (o.op === "add") cur.splice(idx, 0, o.value);
      else cur[idx] = o.value;
    } else if (o.op === "remove") {
      delete cur[last];
    } else {
      cur[last] = o.value;
    }
  }
  return out;
}

/** Fold one AG-UI frame into the block model (returns a new object; the input is not mutated). */
export function foldBlockFrame(prev: BlockFold, frame: BlockFrame): BlockFold {
  const s = clone(prev);
  switch (frame.type) {
    case "RUN_STARTED":
      s.started = true;
      s.done = false;
      s.error = null;
      return s;
    case "TEXT_MESSAGE_START": {
      const id = frame.messageId;
      if (!id) return prev;
      const i = s.blocks.findIndex((b) => b.kind === "text" && b.messageId === id);
      if (i >= 0) {
        s.blocks[i] = { ...(s.blocks[i] as TextBlock), streaming: true };
      } else {
        s.blocks.push({ kind: "text", id: nextId(s, "text"), text: "", streaming: true, messageId: id, ...(s.cached ? { cached: true } : {}) });
      }
      s.openMessageId = id;
      endThinking(s);
      return s;
    }
    case "TEXT_MESSAGE_CONTENT": {
      const id = frame.messageId;
      const delta = typeof frame.delta === "string" ? frame.delta : "";
      if (!id || !delta) return prev;
      const i = s.blocks.findIndex((b) => b.kind === "text" && b.messageId === id);
      if (i >= 0) {
        const b = s.blocks[i] as TextBlock;
        s.blocks[i] = { ...b, text: b.text + delta, streaming: true };
      } else {
        s.blocks.push({ kind: "text", id: nextId(s, "text"), text: delta, streaming: true, messageId: id, ...(s.cached ? { cached: true } : {}) });
      }
      s.openMessageId = id;
      endThinking(s);
      return s;
    }
    case "TEXT_MESSAGE_END": {
      const id = frame.messageId;
      const i = s.blocks.findIndex((b) => b.kind === "text" && b.messageId === id);
      if (i >= 0) s.blocks[i] = { ...(s.blocks[i] as TextBlock), streaming: false };
      if (s.openMessageId === id) s.openMessageId = null;
      return s;
    }
    case "TOOL_CALL_START": {
      const toolCallId = frame.toolCallId;
      const tool = frame.toolCallName ?? PLACEHOLDER_TOOL;
      if (!toolCallId) return prev;
      endThinking(s);
      openTool(s, toolCallId, tool, str(marketrOf(frame).toolUseId));
      return s;
    }
    case "TOOL_CALL_ARGS": {
      const toolCallId = frame.toolCallId;
      const delta = typeof frame.delta === "string" ? frame.delta : "";
      if (!toolCallId) return prev;
      const i = lookupTool(s, toolCallId, undefined);
      if (i < 0) return prev;
      const b = s.blocks[i]!;
      if (b.kind === "genui") {
        // A re-announced call sends "{}" or the same text again: never append twice.
        const argsText = (b as GenUiBlock & { argsText?: string }).argsText ?? "";
        const nextText = b.streaming || !b.program ? argsText + delta : argsText;
        s.blocks[i] = { ...b, program: b.streaming ? partialStringProp(nextText, "program") || b.program : b.program, ...({ argsText: nextText } as object) };
      } else if (b.kind === "tool") {
        if (b.argsComplete) return prev;
        const argsText = b.argsText + delta;
        s.blocks[i] = { ...b, argsText, args: parseArgsText(argsText) ?? b.args };
      }
      return s;
    }
    case "TOOL_CALL_END": {
      const i = lookupTool(s, frame.toolCallId, undefined);
      if (i < 0) return prev;
      const b = s.blocks[i]!;
      if (b.kind === "tool") s.blocks[i] = { ...b, argsComplete: true, args: parseArgsText(b.argsText) ?? b.args };
      return s;
    }
    case "TOOL_CALL_RESULT": {
      const toolCallId = frame.toolCallId;
      if (!toolCallId) return prev;
      const m = marketrOf(frame);
      const toolUseId = str(m.toolUseId);
      const tool = str(m.tool) ?? frame.toolCallName ?? PLACEHOLDER_TOOL;
      const i = openTool(s, toolCallId, tool, toolUseId);
      const b = s.blocks[i]!;
      const status = TOOL_STATUSES.includes(String(m.status)) ? (m.status as ChatToolCall["status"]) : "executed";
      const content = typeof frame.content === "string" ? frame.content : "";
      if (b.kind === "genui") {
        const payload = rec(m.payload);
        const program = typeof payload?.program === "string" ? payload.program : b.program;
        s.blocks[i] = { ...b, program, streaming: false, status, resultText: content };
      } else if (b.kind === "tool") {
        const ui = isToolUiHint(m.ui) ? m.ui : null;
        const next: ToolBlock = {
          ...b,
          status,
          resultText: content,
          ui,
          payload: m.payload ?? null,
          argsComplete: true,
          args: b.args ?? parseArgsText(b.argsText),
          ...(m.confirmed === true ? { confirmed: true } : {}),
          ...(str(m.autoApproved) ? { autoApproved: str(m.autoApproved) } : {}),
          ...(m.cached === true ? { cached: true } : {}),
          ...(str(m.agentKey) ? { agentKey: str(m.agentKey) } : {}),
          ...(tierOf(m.tier) !== null ? { tier: tierOf(m.tier)! } : {}),
          ...(str(m.toolKind) ? { toolKind: str(m.toolKind) } : {}),
        };
        s.blocks[i] = next;
        const delegation = rec(m.delegation);
        if (delegation && typeof delegation.planId === "string" && typeof delegation.parentRunId === "string") {
          const planId = delegation.planId;
          if (!s.blocks.some((x) => x.kind === "delegation" && x.planId === planId)) {
            s.blocks.push({
              kind: "delegation",
              id: nextId(s, "delegation"),
              parentRunId: delegation.parentRunId,
              planId,
              tasks: Number(delegation.tasks) || 0,
              goal: typeof delegation.goal === "string" ? delegation.goal : "",
            });
          }
        }
      }
      if (status === "executed" || status === "error" || status === "denied" || status === "cancelled") {
        settleApproval(s, toolUseId ?? null, toolCallId, status === "executed" ? (m.edited === true ? "edited" : "approved") : status === "cancelled" ? "denied" : "approved");
      }
      return s;
    }
    case "STATE_SNAPSHOT":
      s.sharedState = rec(frame.snapshot) ? structuredClone(rec(frame.snapshot)!) : s.sharedState;
      return s;
    case "STATE_DELTA":
      s.sharedState = applyJsonPatch(s.sharedState, frame.delta);
      return s;
    case "CUSTOM": {
      const v = rec(frame.value) ?? {};
      if (frame.name === "marketr.toolProposal") {
        const toolCallId = str(v.toolCallId) ?? "";
        const toolUseId = str(v.toolUseId) ?? (toolCallId ? s.callToUse[toolCallId] : undefined) ?? null;
        const tool = str(v.tool) ?? PLACEHOLDER_TOOL;
        const i = toolCallId ? openTool(s, toolCallId, tool, toolUseId ?? undefined) : -1;
        const fromBlock = i >= 0 && s.blocks[i]!.kind === "tool" ? (s.blocks[i] as ToolBlock) : null;
        const args = rec(v.args) ?? fromBlock?.args ?? {};
        const tier = tierOf(v.tier);
        const toolKind = str(v.toolKind) ?? fromBlock?.toolKind ?? null;
        const block = currentApproval(s);
        const dup = block.items.some((it) => (toolUseId && it.toolUseId === toolUseId) || it.toolCallId === toolCallId);
        if (!dup) {
          const item: ApprovalItem = {
            toolCallId,
            toolUseId,
            tool,
            args,
            toolKind,
            tier,
            needsClick: v.needsClick === true || tier === 3 || toolKind === "destructive",
            decision: "pending",
            ...(str(v.autoAction) ? { autoAction: str(v.autoAction) } : {}),
            ...(str(v.agentKey) ? { agentKey: str(v.agentKey) } : {}),
            ...(str(v.runId) ? { runId: str(v.runId) } : {}),
            ...(str(v.summary) ? { summary: str(v.summary) } : {}),
          };
          const idx = s.blocks.indexOf(block);
          s.blocks[idx] = { ...block, items: [...block.items, item] };
        }
        if (fromBlock) {
          s.blocks[i] = { ...fromBlock, status: "pending_confirmation", ...(tier !== null ? { tier } : {}), ...(toolKind ? { toolKind } : {}) };
        }
        s.awaiting = true;
        return s;
      }
      if (frame.name === "marketr.thinking") {
        const state = v.state === "ended" ? "ended" : "started";
        const textV = str(v.text);
        const last = s.blocks[s.blocks.length - 1];
        if (state === "started") {
          if (last?.kind === "thinking" && last.active) return prev;
          s.blocks.push({ kind: "thinking", id: nextId(s, "thinking"), active: true });
        } else {
          const i = findLastThinking(s);
          if (i < 0) return prev;
          const b = s.blocks[i] as Extract<ChatBlock, { kind: "thinking" }>;
          s.blocks[i] = { ...b, active: false, ...(textV ? { text: textV } : {}) };
        }
        return s;
      }
      if (frame.name === "marketr.queued") {
        s.queued = true;
        return s;
      }
      if (frame.name === "marketr.cached") {
        s.cached = true;
        for (let i = s.blocks.length - 1; i >= 0; i--) {
          const b = s.blocks[i]!;
          if (b.kind === "text") {
            s.blocks[i] = { ...b, cached: true };
            break;
          }
        }
        return s;
      }
      return prev;
    }
    case "RUN_ERROR": {
      endThinking(s);
      closeStreaming(s);
      s.error = frame.message ?? "The agent turn failed";
      s.done = true;
      s.openApprovalId = null;
      s.blocks.push({ kind: "notice", id: nextId(s, "notice"), text: `Something went wrong: ${s.error}`, tone: "error" });
      return s;
    }
    case "RUN_FINISHED": {
      endThinking(s);
      closeStreaming(s);
      s.done = true;
      hideProposalProse(s);
      s.openApprovalId = null;
      return s;
    }
    default:
      return prev;
  }
}

export function foldBlockFrames(start: BlockFold, frames: readonly BlockFrame[]): BlockFold {
  let s = start;
  for (const f of frames) s = foldBlockFrame(s, f);
  return s;
}

function findLastThinking(s: BlockFold): number {
  for (let i = s.blocks.length - 1; i >= 0; i--) if (s.blocks[i]!.kind === "thinking") return i;
  return -1;
}

function endThinking(s: BlockFold): void {
  const i = findLastThinking(s);
  if (i < 0) return;
  const b = s.blocks[i] as Extract<ChatBlock, { kind: "thinking" }>;
  if (b.active) s.blocks[i] = { ...b, active: false };
}

function closeStreaming(s: BlockFold): void {
  s.blocks = s.blocks.map((b) => (b.kind === "text" && b.streaming ? { ...b, streaming: false } : b.kind === "genui" && b.streaming ? { ...b, streaming: false } : b));
  s.openMessageId = null;
}

/** With an approval block on screen, the "reply yes" prose is redundant: drop it. */
function hideProposalProse(s: BlockFold): void {
  if (!s.blocks.some((b) => b.kind === "approval")) return;
  s.blocks = s.blocks.filter((b) => !(b.kind === "text" && isProposalText(b.text)));
}

// ── Persisted thread → blocks ────────────────────────────────────────────────

/** One AiChatMessage row as the thread API returns it. */
export interface ThreadMessageRow {
  id: string;
  role: string;
  content: string;
  toolCalls: readonly ChatToolCall[] | null;
  createdAt: string;
}

function stableArgs(args: unknown): string {
  try {
    return JSON.stringify(args ?? {}, Object.keys(rec(args) ?? {}).sort());
  } catch {
    return "";
  }
}

function callKey(c: ChatToolCall): string {
  return c.toolUseId ? `use:${c.toolUseId}` : `call:${c.tool}:${stableArgs(c.args)}:${c.confirmed ? "confirmed" : c.status}`;
}

function toolBlockFromCall(id: string, c: ChatToolCall, row: ThreadMessageRow): ToolBlock | GenUiBlock {
  const x = c as ChatToolCall & { ui?: unknown; payload?: unknown; tier?: unknown; toolKind?: unknown; uiState?: unknown; cached?: unknown };
  if (c.tool === RENDER_UI_TOOL) {
    const payload = rec(x.payload);
    const program = typeof payload?.program === "string" ? payload.program : typeof c.args?.program === "string" ? c.args.program : "";
    return {
      kind: "genui",
      id,
      toolCallId: c.toolUseId ? `${c.runId ?? "run"}:tool:${c.toolUseId}` : `${row.id}:${id}`,
      toolUseId: c.toolUseId ?? null,
      program,
      streaming: false,
      status: c.status,
      resultText: c.resultSummary ?? null,
      ...(rec(x.uiState) ? { uiState: rec(x.uiState)! } : {}),
      messageId: row.id,
      createdAt: row.createdAt,
    };
  }
  return {
    kind: "tool",
    id,
    toolCallId: c.toolUseId ? `${c.runId ?? "run"}:tool:${c.toolUseId}` : `${row.id}:${id}`,
    toolUseId: c.toolUseId ?? null,
    tool: c.tool,
    argsText: JSON.stringify(c.args ?? {}),
    args: rec(c.args) ?? {},
    argsComplete: true,
    status: c.status,
    resultText: c.resultSummary ?? null,
    ui: isToolUiHint(x.ui) ? x.ui : null,
    payload: x.payload ?? null,
    ...(c.confirmed ? { confirmed: true } : {}),
    ...(c.autoApproved ? { autoApproved: c.autoApproved } : {}),
    ...(x.cached === true ? { cached: true } : {}),
    ...(c.agentKey ? { agentKey: c.agentKey } : {}),
    ...(c.runId ? { runId: c.runId } : {}),
    ...(tierOf(x.tier) !== null ? { tier: tierOf(x.tier)! } : {}),
    ...(str(x.toolKind) ? { toolKind: str(x.toolKind) } : {}),
    messageId: row.id,
    createdAt: row.createdAt,
  };
}

/**
 * The persisted thread as blocks. Tool calls are keyed (toolUseId, else tool +
 * arguments + confirmed) so a call saved as a `tool` row and repeated on the
 * reply renders once; pending proposals of an assistant row become one
 * approval block; the old "reply yes" prose is hidden behind it; a decision
 * row is a notice.
 */
export function blocksFromThread(rows: readonly ThreadMessageRow[]): ChatBlock[] {
  const out: ChatBlock[] = [];
  const seen = new Map<string, number>();
  /** toolUseId (or call key) → the approval block that already lists it. */
  const listed = new Map<string, number>();
  let seq = 0;
  const id = (prefix: string) => `${prefix}-${++seq}`;
  const settle = (key: string, decision: ApprovalDecision) => {
    const at = listed.get(key);
    if (at === undefined) return;
    const block = out[at]!;
    if (block.kind !== "approval") return;
    out[at] = { ...block, items: block.items.map((it) => ((it.toolUseId ?? it.toolCallId) === key || `call:${it.tool}:${stableArgs(it.args)}:pending_confirmation` === key ? { ...it, decision } : it)) };
  };
  for (const row of rows) {
    const calls = Array.isArray(row.toolCalls) ? row.toolCalls : [];
    if (row.role === "user") {
      const decision = calls.find((c) => c.tool === CHAT_DECISION_TOOL);
      if (decision) {
        out.push({ kind: "notice", id: id("notice"), text: row.content, tone: "decision", messageId: row.id, createdAt: row.createdAt });
      } else {
        out.push({ kind: "user", id: id("user"), text: row.content, messageId: row.id, createdAt: row.createdAt });
      }
      continue;
    }
    if (row.role === "tool") {
      for (const c of calls) {
        const key = callKey(c);
        const at = seen.get(key);
        if (at !== undefined) {
          const prevBlock = out[at]!;
          if (prevBlock.kind === "tool" || prevBlock.kind === "genui") out[at] = { ...toolBlockFromCall(prevBlock.id, c, row), id: prevBlock.id };
          continue;
        }
        const block = toolBlockFromCall(id(c.tool === RENDER_UI_TOOL ? "genui" : "tool"), c, row);
        seen.set(key, out.length);
        out.push(block);
      }
      continue;
    }
    // assistant
    let cached = false;
    const pending: ApprovalItem[] = [];
    for (const c of calls) {
      if (c.tool === CACHED_ANSWER_TOOL) {
        cached = true;
        continue;
      }
      const key = callKey(c);
      const at = seen.get(key);
      if (at === undefined) {
        const block = toolBlockFromCall(id(c.tool === RENDER_UI_TOOL ? "genui" : "tool"), c, row);
        seen.set(key, out.length);
        out.push(block);
      } else if (c.status !== "executed") {
        // A later row knows the call's outcome (cancelled, declined): keep the newest status.
        const prevBlock = out[at]!;
        if (prevBlock.kind === "tool") out[at] = { ...prevBlock, status: c.status, resultText: c.resultSummary ?? prevBlock.resultText };
      }
      // A decided proposal of an earlier row: settle its item instead of listing it again.
      if (c.status === "executed" && c.confirmed) settle(c.toolUseId ?? `call:${c.tool}:${stableArgs(c.args)}:pending_confirmation`, c.edited ? "edited" : "approved");
      else if (c.status === "cancelled") settle(c.toolUseId ?? `call:${c.tool}:${stableArgs(c.args)}:pending_confirmation`, "denied");
      for (const d of c.delegated ?? []) {
        const dk = callKey(d);
        if (seen.has(dk)) continue;
        const block = toolBlockFromCall(id("tool"), d, row);
        seen.set(dk, out.length);
        out.push(block);
      }
      if (c.delegation && !out.some((b) => b.kind === "delegation" && b.planId === c.delegation!.planId)) {
        out.push({ kind: "delegation", id: id("delegation"), ...c.delegation, messageId: row.id });
      }
      if (c.status === "pending_confirmation") {
        const itemKey = c.toolUseId ?? `call:${c.tool}:${stableArgs(c.args)}:pending_confirmation`;
        if (listed.has(itemKey)) continue; // carried into a later reply: the earlier block still shows it
        listed.set(itemKey, -1);
        const x = c as ChatToolCall & { tier?: unknown; toolKind?: unknown };
        const tier = tierOf(x.tier);
        const toolKind = str(x.toolKind) ?? null;
        pending.push({
          toolCallId: c.toolUseId ? `${c.runId ?? "run"}:tool:${c.toolUseId}` : `${row.id}:${c.tool}`,
          toolUseId: c.toolUseId ?? null,
          tool: c.tool,
          args: rec(c.args) ?? {},
          toolKind,
          tier,
          needsClick: tier === 3 || toolKind === "destructive",
          decision: "pending",
          ...(c.autoAction ? { autoAction: c.autoAction } : {}),
          ...(c.agentKey ? { agentKey: c.agentKey } : {}),
          ...(c.runId ? { runId: c.runId } : {}),
        });
      }
    }
    if (pending.length) {
      for (const it of pending) listed.set(it.toolUseId ?? `call:${it.tool}:${stableArgs(it.args)}:pending_confirmation`, out.length);
      out.push({ kind: "approval", id: id("approval"), items: pending, messageId: row.id });
    }
    const text = row.content;
    if (text.trim() && !(pending.length && isProposalText(text))) {
      out.push({ kind: "text", id: id("text"), text, streaming: false, ...(cached ? { cached: true } : {}), messageId: row.id, createdAt: row.createdAt });
    }
  }
  return out;
}

/** The newest approval block with a pending item (the composer's y / n / e target). */
export function pendingApproval(blocks: readonly ChatBlock[]): ApprovalBlock | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.kind === "approval" && b.items.some((it) => it.decision === "pending")) return b;
  }
  return null;
}
