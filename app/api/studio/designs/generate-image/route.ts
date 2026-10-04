// Marketr — studio AI image generation API (Phase 11 "Canvas").
// POST /api/studio/designs/generate-image — { prompt, size } →
//   { dataUrl, width, height }.
//
// Text-to-image for use as design backgrounds/elements. Runs against the
// OpenAI Images API using the SAME BYO key config as the LLM provider
// (LLM_API_KEY / OPENAI_API_KEY, base OPENAI_BASE_URL / LLM_BASE_URL).
// Model defaults to gpt-image-1, overridable via LLM_IMAGE_MODEL.
//
// Generated images are returned to the client — they land in the Uploads
// shelf and are NEVER auto-placed on canvas. No key configured → loud 503,
// never a fake image.

import { z } from "zod";
import { guardWorkspace, httpErrorResponse, readJson } from "../_lib";

export const dynamic = "force-dynamic";

const SIZES = {
  square: { api: "1024x1024", width: 1024, height: 1024 },
  landscape: { api: "1536x1024", width: 1536, height: 1024 },
  portrait: { api: "1024x1536", width: 1024, height: 1536 },
} as const;

const BodySchema = z.object({
  prompt: z.string().trim().min(3).max(2000),
  size: z.enum(["square", "landscape", "portrait"]).default("square"),
});

function imageConfig(): { apiKey: string; baseUrl: string; model: string } {
  // First NON-EMPTY value wins: an empty LLM_API_KEY="" (as copied from
  // .env.example) must not mask OPENAI_API_KEY (Phase 6 single-key mode;
  // mirrored by lib/providers/mock-inventory.ts).
  const apiKey =
    process.env.LLM_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || "";
  const baseUrl = (
    process.env.OPENAI_BASE_URL?.trim() ||
    process.env.LLM_BASE_URL?.trim() ||
    "https://api.openai.com/v1"
  ).replace(/\/+$/, "");
  const model = (process.env.LLM_IMAGE_MODEL ?? "gpt-image-1").trim();
  return { apiKey, baseUrl, model };
}

export async function POST(req: Request) {
  try {
    await guardWorkspace({ editor: true });
    const parsed = BodySchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json({ error: "Invalid request body." }, { status: 400 });
    }
    const { prompt, size } = parsed.data;
    const { apiKey, baseUrl, model } = imageConfig();

    if (!apiKey) {
      return Response.json(
        {
          error:
            "AI image generation needs an image API key. Add LLM_API_KEY (OpenAI) in Settings → Providers, then try again.",
          code: "image_not_configured",
        },
        { status: 503 },
      );
    }

    const dims = SIZES[size];
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/images/generations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          prompt,
          size: dims.api,
          n: 1,
          response_format: "b64_json",
        }),
      });
    } catch {
      return Response.json(
        { error: "Could not reach the image service. Check your connection and base URL.", code: "image_unreachable" },
        { status: 502 },
      );
    }

    if (!res.ok) {
      return Response.json(
        {
          error: `Image generation failed (HTTP ${res.status}). Your key may lack image access or the endpoint may not support it.`,
          code: "image_failed",
        },
        { status: 502 },
      );
    }

    const json = (await res.json()) as { data?: Array<{ b64_json?: string }> };
    const b64 = json?.data?.[0]?.b64_json;
    if (typeof b64 !== "string" || b64.length === 0) {
      return Response.json(
        { error: "The image service returned no image.", code: "image_empty" },
        { status: 502 },
      );
    }

    return Response.json({
      dataUrl: `data:image/png;base64,${b64}`,
      width: dims.width,
      height: dims.height,
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
