// ShapesOS — Phase 22 (chat): the structured payload a tool result carries
// to the transcript (PURE). executeTool() puts it on the ChatToolCall and the
// run event; the AG-UI adapter forwards it as metadata.marketr.payload; the
// typed renderers (components/chat/blocks/ToolResult.tsx) read it.
//
// The 20k-character cap of the Phase 17 tool-result stays: a records payload
// keeps whole rows up to the cap, a text payload is cut, and both name the
// fetch_more handle (the model's tool_use id) so an inline "Load more" can
// read the rest from the saved transcript
// (GET /api/chat/threads/[id]/results/[toolUseId]).

import type { ToolUiHint } from "./ui-hints";

export const TOOL_PAYLOAD_MAX_CHARS = 20_000;

interface ResultLike {
  summary: string;
  details?: unknown;
}

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;

/** The renderer for a result: the tool's declared hint, else inferred from the result's shape. */
export function uiHintFor(tool: { ui?: ToolUiHint } | undefined, result: ResultLike): ToolUiHint {
  if (tool?.ui) return tool.ui;
  const d = result.details;
  if (Array.isArray(d) && d.some((r) => rec(r))) return "records";
  const o = rec(d);
  if (!o) return "text";
  if (Array.isArray(o.rows) && o.rows.some((r) => rec(r))) return "records";
  if (typeof o.program === "string") return "openui";
  if (typeof o.diff === "string") return "diff";
  if (typeof o.fileId === "string" && typeof o.url === "string") {
    const name = typeof o.logicalPath === "string" ? o.logicalPath : typeof o.filename === "string" ? o.filename : "";
    return IMAGE_RE.test(name) ? "image" : "file";
  }
  return "text";
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

function size(v: unknown): number {
  try {
    return JSON.stringify(v).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Build the renderer's payload for a result under the cap (see the header). */
export function uiPayloadFor(ui: ToolUiHint, result: ResultLike, handle: string | undefined): unknown {
  const d = result.details;
  const o = rec(d);
  const more = handle ? { more: { handle } } : {};
  switch (ui) {
    case "records": {
      const all = (Array.isArray(d) ? d : Array.isArray(o?.rows) ? (o!.rows as unknown[]) : []).filter((r): r is Record<string, unknown> => !!rec(r));
      const total = typeof o?.total === "number" ? o.total : all.length;
      const columns: string[] = [];
      for (const r of all.slice(0, 50)) for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);
      const rows: Record<string, unknown>[] = [];
      let used = 120 + columns.join(",").length;
      for (const r of all) {
        const n = size(r) + 1;
        if (used + n > TOOL_PAYLOAD_MAX_CHARS) break;
        rows.push(r);
        used += n;
      }
      const truncated = rows.length < all.length;
      return { rows, columns, total, truncated, ...(truncated ? more : {}) };
    }
    case "file":
    case "image": {
      const path = typeof o?.logicalPath === "string" ? o.logicalPath : typeof o?.filename === "string" ? o.filename : "";
      return { fileId: typeof o?.fileId === "string" ? o.fileId : null, url: typeof o?.url === "string" ? o.url : null, name: baseName(path) || "file", path };
    }
    case "diff":
      return cutText(typeof o?.diff === "string" ? o.diff : "", "diff", more);
    case "openui":
      return { program: typeof o?.program === "string" ? o.program : "" };
    case "plan":
      return {
        goal: typeof o?.goal === "string" ? o.goal : "",
        tasks: Array.isArray(o?.tasks) ? o!.tasks.filter((t) => rec(t)) : [],
        mergeInstructions: typeof o?.mergeInstructions === "string" ? o.mergeInstructions : "",
      };
    case "chart":
      return size(d) <= TOOL_PAYLOAD_MAX_CHARS ? (d ?? null) : null;
    case "text":
    default: {
      let text: string;
      if (d === undefined || d === null) text = "";
      else if (typeof d === "string") text = d;
      else {
        try {
          text = JSON.stringify(d, null, 2);
        } catch {
          text = String(d);
        }
      }
      return cutText(text, "text", more);
    }
  }
}

function cutText(text: string, key: "text" | "diff", more: Record<string, unknown>): Record<string, unknown> {
  if (text.length <= TOOL_PAYLOAD_MAX_CHARS) return { [key]: text, truncated: false };
  return { [key]: text.slice(0, TOOL_PAYLOAD_MAX_CHARS), truncated: true, ...more };
}
