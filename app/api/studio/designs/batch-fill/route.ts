// Marketr — studio designs batch AI fill API (Phase 11 "Canvas" FEATURE 5).
// POST /api/studio/designs/batch-fill — { brief, variables, count } →
// { rows: Record<string,string>[] }.
//
// Draft-first: fills the batch modal's value table; the human reviews and
// edits every row before generating pages. Same provider pattern as
// /api/studio/designs/generate: fails loudly (503) when no LLM key is
// configured — it never returns fake values.

import { z } from "zod";
import { getLlmProviderForWorkspace } from "@/lib/llm/workspace";
import { buildBatchFillPrompt } from "@/lib/design/ai";
import { MAX_BATCH_VARIANTS } from "@/lib/design/variables";
import { guardWorkspace, httpErrorResponse, readJson } from "../_lib";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  brief: z.string().trim().min(3).max(2000),
  variables: z
    .array(z.string().regex(/^[a-zA-Z0-9_]+$/))
    .min(1)
    .max(20),
  count: z.number().int().min(1).max(MAX_BATCH_VARIANTS).default(5),
});

const MAX_OUTPUT_TOKENS = 2048;

/** Extract the first JSON array from model output (fences/prose tolerated). */
function extractJsonArray(text: string): unknown {
  const cleaned = text
    .replace(/^```(?:json)?\s*/im, "")
    .replace(/\s*```\s*$/m, "")
    .trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return undefined;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Validate the model's output: a non-empty array where every item is an
 * object with exactly the requested variable keys mapped to strings.
 * Returns null when anything is off-schema — never a half-fake row set.
 */
function sanitizeRows(parsed: unknown, variables: string[]): Record<string, string>[] | null {
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const rows: Record<string, string>[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const rec = item as Record<string, unknown>;
    const row: Record<string, string> = {};
    for (const v of variables) {
      const val = rec[v];
      if (typeof val !== "string") return null;
      row[v] = val.trim();
    }
    rows.push(row);
  }
  return rows;
}

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const parsed = BodySchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json({ error: "Invalid request body." }, { status: 400 });
    }
    const { brief, variables, count } = parsed.data;

    // Phase 15: the workspace's own model key when it has one; metered by tokens.
    const provider = await getLlmProviderForWorkspace("copy", { workspaceId: workspace.id, actorId: user.id });
    if (!provider.isLive || !provider.isConfigured()) {
      return Response.json(
        {
          error:
            "AI batch fill needs an LLM API key. Add LLM_API_KEY (or ANTHROPIC_API_KEY) in Settings → Providers, then try again.",
          code: "llm_not_configured",
        },
        { status: 503 },
      );
    }

    let raw: string;
    try {
      raw = await provider.generate(buildBatchFillPrompt(brief, variables, count), {
        maxTokens: MAX_OUTPUT_TOKENS,
      });
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : "The AI request failed.", code: "ai_fill_failed" },
        { status: 502 },
      );
    }

    const rows = sanitizeRows(extractJsonArray(raw), variables);
    if (!rows) {
      return Response.json(
        {
          error:
            "The AI response wasn't a usable value table. Try a more specific brief.",
          code: "ai_fill_invalid",
        },
        { status: 502 },
      );
    }
    return Response.json({ rows: rows.slice(0, count) });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
