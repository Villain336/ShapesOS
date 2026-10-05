// ShapesOS — tool-input checks shared by every chat() adapter (Phase 7).
//
// A model's tool input is untrusted output. Before any adapter hands a
// tool_use block back it is checked here, and a block that fails carries an
// `invalid` reason so the caller never runs it:
//   - not parseable JSON (strict JSON.parse of the streamed fragments — the
//     SDKs' tolerant partial-JSON parser can return a silently truncated
//     object, e.g. at an unescaped inner quote, so its result is not trusted);
//   - does not match the tool's JSON schema (eager input streaming turns off
//     the API's own validation, and OpenAI function arguments are free text);
//   - the turn ended on max_tokens (a cut-off input usually still parses) or
//     refusal (a refusal can cut a tool_use off mid-input).
// See the claude-api skill: shared/tool-use-concepts.md → Eager input streaming.

import { z } from "zod";
import type { ChatJsonSchema, ChatStopReason, ChatToolDef, ChatToolResultBlock, ChatToolUseBlock } from "./types";

type Validator = { safeParse(v: unknown): { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } } };

const compiled = new WeakMap<object, Validator | Error>();

function compile(schema: ChatJsonSchema): Validator | Error {
  const hit = compiled.get(schema);
  if (hit) return hit;
  let out: Validator | Error;
  try {
    out = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]) as unknown as Validator;
  } catch (err) {
    out = err instanceof Error ? err : new Error(String(err));
  }
  compiled.set(schema, out);
  return out;
}

/**
 * Check one parsed input against its tool's schema. Returns null when valid,
 * else a short reason (field paths + messages, never the input itself).
 * A schema zod cannot compile is reported as invalid — failing closed: an
 * input we cannot check is never handed back as runnable.
 */
export function validateToolInput(schema: ChatJsonSchema, input: unknown): string | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return "tool input is not a JSON object";
  }
  const v = compile(schema);
  if (v instanceof Error) return `tool schema could not be compiled for validation (${v.message.slice(0, 120)})`;
  const r = v.safeParse(input);
  if (r.success) return null;
  const issues = (r.error?.issues ?? []).slice(0, 5).map((i) => {
    const path = i.path.map(String).join(".");
    return path ? `${path}: ${i.message}` : i.message;
  });
  return `tool input does not match its schema (${issues.join("; ") || "invalid"})`;
}

/** Strictly parse streamed tool-input fragments. Empty → {} (a no-arg call). */
export function parseToolInputJson(json: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const text = json.trim();
  if (!text) return { ok: true, value: {} };
  try {
    const v = JSON.parse(text) as unknown;
    if (v === null || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "tool input is not a JSON object" };
    return { ok: true, value: v as Record<string, unknown> };
  } catch {
    return { ok: false, error: "tool input is not valid JSON" };
  }
}

/** Why a turn's tool calls must not run, from its stop reason; null when they may. */
export function stopReasonBlocksTools(stopReason: ChatStopReason): string | null {
  if (stopReason === "max_tokens" || stopReason === "context_window_exceeded") {
    return "the turn was cut off by the output-token cap; the input may be truncated — retry with a higher maxTokens";
  }
  if (stopReason === "refusal") return "the turn ended in a refusal; its tool calls are never run";
  return null;
}

/**
 * Final check for one tool_use block: the stop reason, then the strict parse
 * (when the raw JSON is known), then the schema of the tool it names.
 */
export function checkToolUse(
  block: { id: string; name: string; input: unknown; rawJson?: string | null },
  tools: readonly ChatToolDef[] | undefined,
  stopReason: ChatStopReason | null,
): ChatToolUseBlock {
  let input: Record<string, unknown> =
    block.input && typeof block.input === "object" && !Array.isArray(block.input) ? (block.input as Record<string, unknown>) : {};
  let invalid: string | null = null;
  if (block.rawJson !== undefined && block.rawJson !== null) {
    const parsed = parseToolInputJson(block.rawJson);
    if (parsed.ok) input = parsed.value;
    else invalid = parsed.error;
  }
  if (!invalid) {
    const def = tools?.find((t) => t.name === block.name);
    invalid = def ? validateToolInput(def.inputSchema, block.rawJson === undefined ? block.input : input) : `unknown tool "${block.name}"`;
  }
  const stop = stopReason ? stopReasonBlocksTools(stopReason) : null;
  if (stop) invalid = invalid ? `${stop}; ${invalid}` : stop;
  const out: ChatToolUseBlock = { type: "tool_use", id: block.id, name: block.name, input };
  if (invalid) out.invalid = invalid;
  return out;
}

/**
 * The tool_result to send back for an invalid tool_use instead of running it
 * (the docs' INVALID_JSON shape, built with JSON.stringify so quotes escape).
 */
export function invalidToolResult(block: ChatToolUseBlock, rawJson?: string): ChatToolResultBlock {
  return {
    type: "tool_result",
    toolUseId: block.id,
    isError: true,
    content: JSON.stringify({
      INVALID_JSON: rawJson ?? JSON.stringify(block.input),
      reason: block.invalid ?? "invalid tool input",
    }),
  };
}
