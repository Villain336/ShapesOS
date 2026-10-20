// ShapesOS — Phase 22 (chat): how the transcript draws a tool's result.
// Declared on ToolDef.ui (lib/chat/tools.ts); carried on the run event and
// TOOL_CALL_RESULT (metadata.marketr.ui) and on the persisted ChatToolCall.
// Tiny and dependency-free so both the tool registry and the pure block
// model (lib/chat/blocks.ts) can import it without a cycle.

export type ToolUiHint = "records" | "file" | "image" | "diff" | "chart" | "text" | "openui" | "plan";

export const TOOL_UI_HINTS: readonly ToolUiHint[] = ["records", "file", "image", "diff", "chart", "text", "openui", "plan"];

export function isToolUiHint(v: unknown): v is ToolUiHint {
  return typeof v === "string" && (TOOL_UI_HINTS as readonly string[]).includes(v);
}

/** The render_ui tool: its arguments ARE the generative-UI program (Phase 22). */
export const RENDER_UI_TOOL = "render_ui";
/** Phase 17: the marker a cached answer carries (lib/chat/answer-cache.ts). */
export const CACHED_ANSWER_TOOL = "cached_answer";
/** Phase 22: a decision made from an approval block is saved as a user row with this marker. */
export const CHAT_DECISION_TOOL = "chat_decision";
