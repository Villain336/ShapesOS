// ShapesOS — social API shared helpers (Phase 4b).
// Every route: guardWorkspace (session + workspace; editor+ for mutations)
// and errorResponse for anything thrown. Bodies are validated with zod.

import { z } from "zod";
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { FsError } from "@/lib/filesystem/service";
import { HttpError } from "@/lib/api/errors";
import { PostizApiError, PostizConfigError } from "@/lib/integrations/postiz";

export { guardWorkspace, readJson };

export function socialError(e: unknown): Response {
  if (e instanceof FsError) {
    const status = e.code === "not_found" ? 404 : e.code === "conflict" ? 409 : e.code === "quota_exceeded" || e.code === "too_large" ? 413 : 400;
    return Response.json({ error: e.message }, { status });
  }
  if (e instanceof PostizConfigError) return Response.json({ error: e.message }, { status: 400 });
  if (e instanceof PostizApiError) return Response.json({ error: e.message }, { status: e.status >= 500 ? 502 : e.status });
  if (e instanceof HttpError) {
    return Response.json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, { status: e.status });
  }
  return httpErrorResponse(e);
}

export const ChannelSchema = z.object({
  id: z.string().trim().min(1).max(120),
  identifier: z.string().trim().max(64).default(""),
  name: z.string().trim().max(200).default(""),
});

export const MediaRefSchema = z.object({
  fileId: z.string().trim().min(1).max(64),
  filename: z.string().max(255).optional(),
  mimeType: z.string().max(100).optional(),
  kind: z.enum(["image", "video"]).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
});

export const PostBodySchema = z.object({
  content: z.string().max(10_000).optional(),
  link: z.string().trim().max(2000).nullable().optional(),
  utmCampaign: z.string().trim().max(120).nullable().optional(),
  channels: z.array(ChannelSchema).max(20).optional(),
  media: z.array(MediaRefSchema).max(10).optional(),
  publishMode: z.enum(["now", "schedule"]).optional(),
  scheduledFor: z.string().trim().max(64).nullable().optional(),
});

/** Media refs from the client → the service's SocialMedia (the server re-reads type/size). */
export function toMedia(refs: z.infer<typeof MediaRefSchema>[] | undefined) {
  return refs?.map((m) => ({
    fileId: m.fileId,
    filename: m.filename ?? "media",
    mimeType: m.mimeType ?? "application/octet-stream",
    kind: m.kind ?? ("image" as const),
    sizeBytes: m.sizeBytes ?? 0,
    width: m.width ?? null,
    height: m.height ?? null,
  }));
}

export function toChannels(refs: z.infer<typeof ChannelSchema>[] | undefined) {
  return refs?.map((c) => ({ id: c.id, identifier: c.identifier, name: c.name || c.id }));
}
