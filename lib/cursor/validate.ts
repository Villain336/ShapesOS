// ShapesOS — Phase 19A (WS=server): request shapes for /api/cursor/* (PURE).

import { z } from "zod";

export const MAX_SCREENSHOTS = 4;
/** Decoded screenshot bytes per turn (contract: ≤ 6 MB, else 413). */
export const MAX_SCREENSHOT_BYTES = 6 * 1024 * 1024;
/** The turn body (base64 inflates by 4/3, plus the rest): under proxy.ts's 10 MiB. */
export const MAX_TURN_BODY_BYTES = 9 * 1024 * 1024;
export const MAX_TRANSCRIPT_CHARS = 4_000;
export const MAX_UI_MAP = 400;

const finite = z.number().finite();

export const ScreenshotSchema = z.object({
  screen: z.number().int().min(0).max(15),
  width: finite.int().min(1).max(16_384),
  height: finite.int().min(1).max(16_384),
  scaleFactor: finite.gt(0).max(8),
  primary: z.boolean(),
  jpegBase64: z.string().min(4).regex(/^[A-Za-z0-9+/]+={0,2}$/, "jpegBase64 must be base64"),
});

export const UiMapEntrySchema = z.object({
  id: z.string().min(1).max(200),
  label: z.string().max(200),
  role: z.string().max(40),
  rect: z.object({ x: finite, y: finite, w: finite.min(0), h: finite.min(0) }),
});

export const TurnBodySchema = z.object({
  conversationId: z.string().min(1).max(64).optional().nullable(),
  transcript: z.string().trim().min(1, "Say something first.").max(MAX_TRANSCRIPT_CHARS),
  screenshots: z.array(ScreenshotSchema).max(64).default([]),
  uiMap: z.array(UiMapEntrySchema).max(MAX_UI_MAP).optional(),
  app: z
    .object({ name: z.string().max(120), title: z.string().max(300).optional(), url: z.string().max(2000).optional(), isShapesOS: z.boolean() })
    .optional()
    .nullable(),
  mode: z.enum(["answer", "agent"]).optional(),
  /** Phase 19A contract addition: how long the talk key was held (metering beyond the first minute). */
  talkSeconds: finite.min(0).max(3_600).optional(),
});
export type TurnBody = z.infer<typeof TurnBodySchema>;

/** Decoded size of a base64 string. */
export function base64Bytes(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/** Contract limits → 413 reasons (null = fine). */
export function screenshotLimitError(shots: ReadonlyArray<{ jpegBase64: string; screen: number }>): string | null {
  if (shots.length > MAX_SCREENSHOTS) return `At most ${MAX_SCREENSHOTS} screenshots per turn.`;
  const total = shots.reduce((n, s) => n + base64Bytes(s.jpegBase64), 0);
  if (total > MAX_SCREENSHOT_BYTES) return "The screenshots are larger than 6 MB together.";
  return null;
}

export const ApproveBodySchema = z.object({
  approvalId: z.string().min(1).max(64),
  decision: z.enum(["approve", "reject"]),
  via: z.enum(["voice", "click"]),
});

export const TtsBodySchema = z.object({
  text: z.string().trim().min(1).max(2_000),
  voice: z.string().min(1).max(120).optional().nullable(),
});

export const AgentBodySchema = z.object({
  goal: z.string().trim().min(1).max(2_000),
  maxUsd: finite,
  conversationId: z.string().min(1).max(64).optional().nullable(),
});

export const TranscribeTokenBodySchema = z
  .object({
    /** Optional: the conversation the talk session belongs to (metering evidence only). */
    conversationId: z.string().min(1).max(64).optional().nullable(),
  })
  .partial();
