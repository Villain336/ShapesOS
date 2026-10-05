// Marketr — studio AI image generation API (Phase 11 "Canvas").
// POST /api/studio/designs/generate-image — { prompt, size } →
//   { dataUrl, width, height }.
//
// Text-to-image for use as design backgrounds/elements. Phase 7: a thin
// wrapper over the single image service (lib/images/openai.ts), which owns
// the key resolution (the LLM router's OPENAI_API_KEY / LLM_API_KEY), the
// model (gpt-image-2 by default, LLM_IMAGE_MODEL overrides, image
// allow-list in lib/llm/router.ts), timeouts and error classification. The
// service no longer sends `response_format` (unsupported for GPT image
// models, which always return base64).
//
// Generated images are returned to the client — they land in the Uploads
// shelf and are NEVER auto-placed on canvas. No key configured → loud 503,
// never a fake image.

import { z } from "zod";
import { guardWorkspace, httpErrorResponse, readJson } from "../_lib";
import { ImageConfigError, ImageRequestError, generateImage } from "@/lib/images/openai";
import { LlmProviderError } from "@/lib/llm/errors";
import { randomUUID } from "node:crypto";
import { checkCap, meter } from "@/lib/metering/service";
import { imageGenerationCredits } from "@/lib/metering/credits";
import { capDeniedMessage } from "@/lib/metering/wiring";

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

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const parsed = BodySchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json({ error: "Invalid request body." }, { status: 400 });
    }
    const { prompt, size } = parsed.data;
    const dims = SIZES[size];

    // Phase 15.2: the studio image route is metered like the chat tool —
    // a capped workspace never reaches OpenAI, and each image is charged
    // IMAGE_CREDITS_BY_QUALITY (medium, 22 credits at 1024×1024) once.
    const quality = "medium" as const;
    const cap = await checkCap(workspace.id);
    if (!cap.allowed) {
      return Response.json({ error: capDeniedMessage(cap.used, cap.capCredits), code: "cap_exceeded" }, { status: 402 });
    }
    const chargeKey = `studio-image:${workspace.id}:${randomUUID()}`;

    let b64: string;
    try {
      const result = await generateImage({ prompt, size: dims.api, n: 1, quality }, { signal: req.signal });
      b64 = result.images[0]!.bytes.toString("base64");
      // Debit after the image exists (the work is done and paid for):
      // recorded even past the cap; idempotent per generation.
      await meter({
        workspaceId: workspace.id,
        actorId: user.id,
        action: "image_generation",
        credits: imageGenerationCredits({ quality, size: dims.api }),
        keySource: "platform",
        afterTheFact: true,
        idempotencyKey: chargeKey,
        evidenceRef: `studio-image:${size}`,
      }).catch((err) => console.error("[studio-image] metering failed:", err instanceof Error ? err.message : err));
    } catch (e) {
      if (e instanceof ImageConfigError) {
        return Response.json(
          {
            error:
              e.code === "image_not_configured"
                ? "AI image generation needs an OpenAI key. Add OPENAI_API_KEY in Settings → Providers, then try again."
                : e.message,
            code: e.code,
          },
          { status: 503 },
        );
      }
      if (e instanceof ImageRequestError) {
        return Response.json({ error: e.message }, { status: 400 });
      }
      if (e instanceof LlmProviderError) {
        if (e.kind === "network" || e.kind === "timeout") {
          return Response.json(
            { error: "Could not reach the image service. Check your connection and base URL.", code: "image_unreachable" },
            { status: 502 },
          );
        }
        if (e.kind === "empty") {
          return Response.json({ error: "The image service returned no image.", code: "image_empty" }, { status: 502 });
        }
        return Response.json(
          {
            error: `Image generation failed${e.status ? ` (HTTP ${e.status})` : ""}. Your key may lack image access or the endpoint may not support it.`,
            code: "image_failed",
          },
          { status: 502 },
        );
      }
      throw e;
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
