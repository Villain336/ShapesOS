// ShapesOS — the `generate_image` agent tool (Phase 7, `media` tool group).
//
// kind "spend" (costs OpenAI money, so the confirmation gate holds it) and
// automation action "draft_image" (Tier 0, so a per-agent auto-approve rule
// may let it run without the "yes"). Flow:
//   role → service configured? → args valid? → spend cap → OpenAI →
//   WorkspaceFile (lib/filesystem) → meter (lib/metering, image_generation)
// With no OpenAI key it says so and generates nothing — never a fake image.

import type { ToolDef } from "@/lib/chat/tools";
import { roleAtLeast } from "@/lib/authz";
import { checkCap, meter } from "@/lib/metering/service";
import { imageGenerationCredits } from "@/lib/metering/credits";
import { capDeniedMessage } from "@/lib/metering/wiring";
import {
  IMAGE_NOT_CONFIGURED_MESSAGE,
  ImageConfigError,
  ImageRequestError,
  generateImage,
  imageServiceStatus,
  isImageQuality,
  validateImageSize,
  type ImageQuality,
} from "./openai";
import { storeGeneratedImage } from "./files";

/** Friendly aliases the model may use for the three standard sizes. */
const SIZE_ALIASES: Record<string, string> = {
  square: "1024x1024",
  landscape: "1536x1024",
  portrait: "1024x1536",
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export const generate_image: ToolDef = {
  name: "generate_image",
  description:
    "Generate an image with OpenAI's image model (the one ChatGPT uses) and save it as a PNG in this project's files. Costs image credits (metered). Use for hero images, social post images and newsletter art. Returns the file id and a link.",
  kind: "spend",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "What the image should show, including style and any text in it." },
      size: {
        type: "string",
        description: "1024x1024 (square, default), 1536x1024 (landscape), 1024x1536 (portrait), auto, or WIDTHxHEIGHT (edges multiples of 16, at most 3:1).",
      },
      quality: { type: "string", description: "low (quick drafts), medium (default) or high (final assets; costs more)." },
      fileName: { type: "string", description: "File name for the saved PNG (optional)." },
    },
    required: ["prompt"],
  },
  async execute(ctx, args) {
    if (!roleAtLeast(ctx.role, "editor")) throw new Error("editor role required");

    const status = imageServiceStatus();
    if (!status.configured) {
      return { summary: IMAGE_NOT_CONFIGURED_MESSAGE, details: { error: "image_not_configured" } };
    }
    if (!status.modelAllowed) {
      return { summary: `Image generation is off: ${status.reason}`, details: { error: "image_model_not_allowed" } };
    }

    const prompt = str(args.prompt);
    if (!prompt) throw new Error("prompt is required");
    const rawQuality = str(args.quality)?.toLowerCase() ?? "medium";
    if (!isImageQuality(rawQuality)) throw new Error(`Invalid quality "${rawQuality}". Use low, medium or high.`);
    const quality: ImageQuality = rawQuality;
    const rawSize = str(args.size)?.toLowerCase() ?? "1024x1024";
    let size: string;
    try {
      size = validateImageSize(SIZE_ALIASES[rawSize] ?? rawSize, status.model);
    } catch (e) {
      throw new Error(e instanceof ImageRequestError ? e.message : "Invalid size.");
    }

    // Pre-spend cap gate: a capped workspace never reaches OpenAI. meter()
    // below stays the authoritative per-charge check.
    const cap = await checkCap(ctx.workspaceId);
    if (!cap.allowed) {
      return { summary: capDeniedMessage(cap.used, cap.capCredits), details: { error: "cap_exceeded" } };
    }

    let result;
    try {
      result = await generateImage({ prompt, size, quality }, { signal: ctx.signal });
    } catch (e) {
      if (e instanceof ImageConfigError) return { summary: e.message, details: { error: e.code } };
      throw e; // LlmProviderError: status + code only, never key material
    }

    const stored = await storeGeneratedImage({
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      userId: ctx.userId,
      bytes: result.images[0]!.bytes,
      fileName: str(args.fileName) ?? prompt.slice(0, 40),
    });

    const credits = imageGenerationCredits({ quality, size });
    const charge = await meter({
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.userId,
      action: "image_generation",
      credits,
      idempotencyKey: `imagegen:${stored.file.id}`,
      evidenceRef: `chat-image:${stored.file.id}`,
    });

    return {
      summary: `Image saved to ${stored.file.logicalPath} (${size}, ${quality} quality, ${result.model}). File ${stored.file.id}.${
        charge.ok ? ` ${charge.charged} credits.` : ` Not metered: ${charge.message}`
      }`,
      details: {
        fileId: stored.file.id,
        url: stored.url,
        logicalPath: stored.file.logicalPath,
        model: result.model,
        size,
        quality,
        credits: charge.ok ? charge.charged : 0,
        metered: charge.ok,
        usage: result.usage,
      },
    };
  },
};
