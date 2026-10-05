// Marketr — studio designs AI generation API (Phase 11 "Canvas").
// POST /api/studio/designs/generate — { prompt, width, height } →
///  { document: DesignDocument }.
//
// Draft-first: the LLM proposes a design draft; the human edits it in the
// editor. Output is constrained to the design JSON schema, validated with
// validateDesignDocument, and repaired once on failure. When no LLM key is
// configured the route fails loudly (503) — it never returns a fake design.

import { z } from "zod";
import { getLlmProviderForWorkspace } from "@/lib/llm/workspace";
import { validateDesignDocument } from "@/lib/design/validate";
import { buildDesignPrompt, extractJsonObject } from "@/lib/design/ai";
import { guardWorkspace, httpErrorResponse, readJson } from "../_lib";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  prompt: z.string().trim().min(3).max(2000),
  width: z.number().int().min(100).max(4000).default(1080),
  height: z.number().int().min(100).max(4000).default(1080),
});

const MAX_OUTPUT_TOKENS = 4096;

async function tryGenerate(
  generate: (prompt: string) => Promise<string>,
  prompt: string,
  width: number,
  height: number,
): Promise<{ ok: true; doc: unknown } | { ok: false; error: string }> {
  let raw: string;
  try {
    raw = await generate(buildDesignPrompt(prompt, width, height));
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "The AI request failed.",
    };
  }

  const parsed = extractJsonObject(raw);
  if (parsed === undefined) {
    return { ok: false, error: "The AI response did not contain a design document." };
  }
  const first = validateDesignDocument(parsed);
  if (first.ok) return { ok: true, doc: first.doc };

  // One repair attempt: hand the validation error back to the model.
  let repaired: string;
  try {
    repaired = await generate(
      `Your previous design JSON was rejected: ${first.error}\n` +
        "Fix ONLY what is wrong and return the complete corrected JSON object — nothing else.\n\n" +
        buildDesignPrompt(prompt, width, height),
    );
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "The AI repair request failed.",
    };
  }
  const reparsed = extractJsonObject(repaired);
  if (reparsed === undefined) {
    return { ok: false, error: "The AI repair response did not contain a design document." };
  }
  const second = validateDesignDocument(reparsed);
  if (second.ok) return { ok: true, doc: second.doc };
  return {
    ok: false,
    error: `The AI design failed validation twice (${second.error}). Try rephrasing your prompt.`,
  };
}

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const parsed = BodySchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json({ error: "Invalid request body." }, { status: 400 });
    }
    const { prompt, width, height } = parsed.data;

    // Phase 15: the workspace's own model key when it has one; metered by tokens.
    const provider = await getLlmProviderForWorkspace("copy", { workspaceId: workspace.id, actorId: user.id });
    if (!provider.isLive || !provider.isConfigured()) {
      return Response.json(
        {
          error:
            "AI design generation needs an LLM API key. Add LLM_API_KEY (or ANTHROPIC_API_KEY) in Settings → Providers, then try again.",
          code: "llm_not_configured",
        },
        { status: 503 },
      );
    }

    const result = await tryGenerate(
      (p) => provider.generate(p, { maxTokens: MAX_OUTPUT_TOKENS }),
      prompt,
      width,
      height,
    );
    if (!result.ok) {
      return Response.json({ error: result.error, code: "ai_generation_failed" }, { status: 502 });
    }
    return Response.json({ document: result.doc });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
