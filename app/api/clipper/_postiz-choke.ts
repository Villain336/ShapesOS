// Marketr — Phase 13C: Postiz choke point for the clipper.
//
// DRAFT-FIRST IS LOAD-BEARING. This module is the ONLY path by which the
// clipper talks to the Postiz API, and it ONLY EVER creates DRAFTS.
//
//   - The post TYPE is hardcoded to "draft" in queueClipDraftToPostiz().
//   - The PostizPostType union is intentionally NOT exposed here, so no
//     caller can smuggle "now" or "schedule" through this module.
//   - No user action, job, or UI flow in the clipper may trigger a live
//     publish. Publishing happens only when a human opens the draft in
//     Postiz (or the dedicated integrations UI) and confirms.
//
// Search the codebase for CLIPPER_POSTIZ_CHOKEPOINT to audit every call.

import { schedulePostizPost } from "@/lib/integrations/postiz";

// The literal "draft" must appear in exactly one place (below) — grep for
// CLIPPER_POSTIZ_CHOKEPOINT to find it and its callers.
const CLIPPER_POSTIZ_CHOKEPOINT = "draft-only";

export interface QueuedClipDraft {
  /** Postiz draft id (whatever the sidecar returned), stored on the clip. */
  postizRef: string;
  raw: unknown;
}

export async function queueClipDraftToPostiz(input: {
  /** Postiz integration ids to attach the draft to. */
  channelIds: string[];
  /** Draft body text. */
  content: string;
  /** Optional platform __type map per channel (same shape as the main posts route). */
  platformTypes?: Record<string, string>;
}): Promise<QueuedClipDraft> {
  // CLIPPER_POSTIZ_CHOKEPOINT: hardcoded "draft" — never "now", never "schedule".
  void CLIPPER_POSTIZ_CHOKEPOINT;
  const raw = await schedulePostizPost({
    type: "draft",
    content: input.content,
    channelIds: input.channelIds,
    platformTypes: input.platformTypes,
  });
  const r = raw as Record<string, unknown> | null;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;
  const postizRef =
    str(r?.id) ??
    str((r?.data as Record<string, unknown> | undefined)?.id) ??
    "draft";
  return { postizRef, raw };
}
