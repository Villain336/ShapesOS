// ShapesOS — social posts: drafts, approval, dispatch, status (Phase 4b).
//
// Lifecycle (one SocialPublication row per post):
//   draft ──submit──▶ pending_approval ──approve──▶ approved ──dispatch──▶
//     scheduled (handed to the provider) ──provider confirms──▶ published
//   deny → back to draft with the reviewer's note; dispatch/provider error
//   → failed (editable, resubmittable); cancel → cancelled.
//
// Publishing is a real-world action, so every post goes through the unified
// approval inbox (source "social"): an editor+ other than the requester
// approves (a solo workspace may self-approve, same rule as tool actions).
// Approval dispatches immediately ("now") or at the scheduled time (handed to
// Postiz with its date). Outbound links are UTM-tagged per channel at
// dispatch (lib/social/utm.ts). A confirmed publish emits the
// social_post.published webhook.
//
// Every table access runs inside withWorkspaceScope (FORCE RLS).

import { Prisma, type SocialPublication, type SocialPublicationStatus, type WorkspaceRole } from "@prisma/client";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { roleAtLeast } from "@/lib/authz";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "@/lib/api/errors";
import { getFile, readFile, writeFile } from "@/lib/filesystem/service";
import { emitWebhookEvent } from "@/lib/webhooks/emit";
import { notifyApprovalDecided, notifyApprovalNeeded } from "@/lib/notifications/producers";
import { log } from "@/lib/observability/log";
import { containsEicar } from "@/lib/security/upload-safety";
import {
  checkSocialUpload,
  normalizePlatform,
  readMedia,
  validatePost,
  type SocialMedia,
} from "./platforms";
import { buildChannelBody, defaultCampaign, slugCampaign } from "./utm";
import type { ProviderChannel, ProviderPostStatus, SocialProvider } from "./provider";

export const SOCIAL_MEDIA_ROOT = "/files/social";
export const MAX_MEDIA_PER_POST = 10;
export const MAX_CHANNELS_PER_POST = 20;
/** A dispatch claim older than this with no provider refs is treated as crashed. */
export const STALE_DISPATCH_MS = 15 * 60_000;

export interface PostChannel {
  id: string;
  identifier: string;
  name: string;
}

export interface ProviderRef {
  postId: string;
  integrationId: string;
  platform: string;
  state?: string | null;
  releaseUrl?: string | null;
}

export interface PostMetricsTotals {
  impressions: number;
  likes: number;
  comments: number;
  shares: number;
  clicks: number;
  engagements: number;
  mock: boolean;
}

export interface SerializedPost {
  id: string;
  content: string;
  link: string | null;
  utmCampaign: string | null;
  channels: PostChannel[];
  platforms: string[];
  media: SocialMedia[];
  publishMode: "now" | "schedule";
  scheduledFor: string | null;
  status: SocialPublicationStatus;
  source: string;
  sourceRef: string | null;
  provider: string | null;
  providerRefs: ProviderRef[];
  createdBy: string;
  requestedBy: string | null;
  requestedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  publishedAt: string | null;
  error: string | null;
  metricsSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
  metrics: PostMetricsTotals | null;
}

type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// JSON coercion
// ---------------------------------------------------------------------------

export function readChannels(raw: unknown): PostChannel[] {
  if (!Array.isArray(raw)) return [];
  const out: PostChannel[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const r = c as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id) continue;
    out.push({
      id: r.id,
      identifier: typeof r.identifier === "string" ? r.identifier : "",
      name: typeof r.name === "string" ? r.name : r.id,
    });
  }
  return out;
}

export function readRefs(raw: unknown): ProviderRef[] {
  if (!Array.isArray(raw)) return [];
  const out: ProviderRef[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const r = c as Record<string, unknown>;
    if (typeof r.postId !== "string" || !r.postId) continue;
    out.push({
      postId: r.postId,
      integrationId: typeof r.integrationId === "string" ? r.integrationId : "",
      platform: typeof r.platform === "string" ? r.platform : "other",
      state: typeof r.state === "string" ? r.state : null,
      releaseUrl: typeof r.releaseUrl === "string" ? r.releaseUrl : null,
    });
  }
  return out;
}

function json(v: unknown): Prisma.InputJsonValue {
  return v as Prisma.InputJsonValue;
}

export function serializePost(row: SocialPublication, metrics: PostMetricsTotals | null = null): SerializedPost {
  const channels = readChannels(row.channels);
  return {
    id: row.id,
    content: row.content,
    link: row.link,
    utmCampaign: row.utmCampaign,
    channels,
    platforms: [...new Set(channels.map((c) => normalizePlatform(c.identifier)))],
    media: readMedia(row.media),
    publishMode: row.publishMode === "schedule" ? "schedule" : "now",
    scheduledFor: row.scheduledFor?.toISOString() ?? null,
    status: row.status,
    source: row.source,
    sourceRef: row.sourceRef,
    provider: row.provider,
    providerRefs: readRefs(row.providerRefs),
    createdBy: row.createdBy,
    requestedBy: row.requestedBy,
    requestedAt: row.requestedAt?.toISOString() ?? null,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    error: row.error,
    metricsSyncedAt: row.metricsSyncedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    metrics,
  };
}

/** One-line title for lists, inbox and search. */
export function postTitle(p: { content: string; media?: unknown }): string {
  const t = p.content.replace(/\s+/g, " ").trim();
  if (t) return t.length > 80 ? `${t.slice(0, 79)}…` : t;
  const n = readMedia(p.media).length;
  return n ? `Media post (${n} attachment${n === 1 ? "" : "s"})` : "Untitled post";
}

// ---------------------------------------------------------------------------
// Media upload (workspace filesystem, /files/social/…)
// ---------------------------------------------------------------------------

async function imageSize(bytes: Buffer): Promise<{ width: number | null; height: number | null }> {
  try {
    const meta = await sharp(bytes).metadata();
    return { width: meta.width ?? null, height: meta.height ?? null };
  } catch {
    return { width: null, height: null };
  }
}

function safeBase(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const stem = base.replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return stem || "media";
}

/**
 * Store one social media file. The bytes decide the type (images: JPEG,
 * PNG, GIF, WebP; video: MP4, MOV, WebM); size caps per kind. Images also
 * pass the shared upload-safety gate inside writeFile.
 */
export async function storeSocialMedia(opts: {
  workspaceId: string;
  userId: string;
  bytes: Buffer;
  filename: string;
  folder?: string;
  now?: Date;
}): Promise<SocialMedia> {
  const check = checkSocialUpload(opts.bytes);
  if (!check.ok) throw new BadRequestError(check.reason);
  if (containsEicar(opts.bytes)) throw new BadRequestError("The file was rejected by the malware check.");
  const month = (opts.now ?? new Date()).toISOString().slice(0, 7);
  const folder = opts.folder ? opts.folder.replace(/[^a-z0-9-]/g, "") || "uploads" : "uploads";
  const filename = `${safeBase(opts.filename)}-${randomUUID().slice(0, 8)}.${check.ext}`;
  const file = await writeFile({
    workspaceId: opts.workspaceId,
    logicalPath: `${SOCIAL_MEDIA_ROOT}/${folder}/${month}/${filename}`,
    kind: "file",
    bytes: opts.bytes,
    mimeType: check.mimeType,
    createdBy: opts.userId,
    maxBytes: opts.bytes.length,
    // Video is outside the generic gate's allow-list; it was sniffed above
    // as ISO-BMFF/EBML video and is served back with nosniff + sandbox CSP.
    skipSafety: check.kind === "video",
  });
  const dims = check.kind === "image" ? await imageSize(opts.bytes) : { width: null, height: null };
  return {
    fileId: file.id,
    filename: file.filename,
    mimeType: check.mimeType,
    kind: check.kind,
    sizeBytes: file.sizeBytes,
    width: dims.width,
    height: dims.height,
  };
}

/** Media attached to a post must be live social files of this workspace. */
async function verifyMedia(workspaceId: string, media: SocialMedia[]): Promise<SocialMedia[]> {
  if (media.length > MAX_MEDIA_PER_POST) throw new BadRequestError(`Attach up to ${MAX_MEDIA_PER_POST} files.`);
  const out: SocialMedia[] = [];
  for (const m of media) {
    const f = await getFile({ workspaceId, fileId: m.fileId });
    if (!f || !f.logicalPath.startsWith(`${SOCIAL_MEDIA_ROOT}/`)) throw new BadRequestError("A media file is missing. Upload it again.");
    const kind = f.mimeType.startsWith("video/") ? "video" : "image";
    out.push({ ...m, filename: f.filename, mimeType: f.mimeType, sizeBytes: f.sizeBytes, kind });
  }
  return out;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface PostInput {
  content?: string;
  link?: string | null;
  utmCampaign?: string | null;
  channels?: PostChannel[];
  media?: SocialMedia[];
  publishMode?: "now" | "schedule";
  scheduledFor?: string | null;
}

function cleanLink(link: string | null | undefined): string | null {
  const l = (link ?? "").trim();
  if (!l) return null;
  let u: URL;
  try {
    u = new URL(l);
  } catch {
    throw new BadRequestError("Link must be a full http(s) URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new BadRequestError("Link must be a full http(s) URL.");
  return u.toString();
}

function cleanChannels(channels: PostChannel[]): PostChannel[] {
  const seen = new Set<string>();
  const out: PostChannel[] = [];
  for (const c of channels) {
    if (!c.id || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push({ id: c.id.slice(0, 120), identifier: (c.identifier ?? "").slice(0, 64), name: (c.name ?? c.id).slice(0, 200) });
  }
  if (out.length > MAX_CHANNELS_PER_POST) throw new BadRequestError(`Pick up to ${MAX_CHANNELS_PER_POST} channels.`);
  return out;
}

function parseWhen(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) throw new BadRequestError("Scheduled time must be a valid date and time.");
  return d;
}

export async function createPost(
  workspaceId: string,
  userId: string,
  input: PostInput & { source?: string; sourceRef?: string | null },
): Promise<SerializedPost> {
  const media = await verifyMedia(workspaceId, input.media ?? []);
  const row = await withWorkspaceScope(workspaceId, (tx) =>
    tx.socialPublication.create({
      data: {
        workspaceId,
        createdBy: userId,
        content: (input.content ?? "").slice(0, 10_000),
        link: cleanLink(input.link),
        utmCampaign: input.utmCampaign?.trim().slice(0, 120) || null,
        channels: json(cleanChannels(input.channels ?? [])),
        media: json(media),
        publishMode: input.publishMode === "schedule" ? "schedule" : "now",
        scheduledFor: input.publishMode === "schedule" ? parseWhen(input.scheduledFor) : null,
        source: input.source ?? "compose",
        sourceRef: input.sourceRef ?? null,
      },
    }),
  );
  return serializePost(row);
}

async function loadRow(tx: Tx, workspaceId: string, id: string): Promise<SocialPublication> {
  const row = await tx.socialPublication.findFirst({ where: { id, workspaceId } });
  if (!row) throw new NotFoundError("Post not found.");
  return row;
}

export async function getPost(workspaceId: string, id: string): Promise<SerializedPost> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const row = await loadRow(tx, workspaceId, id);
    const totals = await metricTotals(tx, workspaceId, [row.id]);
    return serializePost(row, totals.get(row.id) ?? null);
  });
}

const EDITABLE: SocialPublicationStatus[] = ["draft", "failed"];

export async function updatePost(workspaceId: string, id: string, input: PostInput): Promise<SerializedPost> {
  const media = input.media ? await verifyMedia(workspaceId, input.media) : undefined;
  return withWorkspaceScope(workspaceId, async (tx) => {
    const row = await loadRow(tx, workspaceId, id);
    if (!EDITABLE.includes(row.status)) throw new ConflictError("Only drafts and failed posts can be edited.");
    const data: Prisma.SocialPublicationUpdateInput = { status: "draft", error: null };
    if (input.content !== undefined) data.content = input.content.slice(0, 10_000);
    if (input.link !== undefined) data.link = cleanLink(input.link);
    if (input.utmCampaign !== undefined) data.utmCampaign = input.utmCampaign?.trim().slice(0, 120) || null;
    if (input.channels !== undefined) data.channels = json(cleanChannels(input.channels));
    if (media !== undefined) data.media = json(media);
    if (input.publishMode !== undefined) data.publishMode = input.publishMode === "schedule" ? "schedule" : "now";
    const mode = input.publishMode ?? row.publishMode;
    if (input.scheduledFor !== undefined || input.publishMode !== undefined) {
      data.scheduledFor = mode === "schedule" ? parseWhen(input.scheduledFor ?? row.scheduledFor?.toISOString() ?? null) : null;
    }
    const updated = await tx.socialPublication.update({ where: { id: row.id, workspaceId }, data });
    return serializePost(updated);
  });
}

/** Delete a draft/failed/cancelled post; cancel a pending or scheduled one. */
export async function deleteOrCancelPost(
  workspaceId: string,
  id: string,
): Promise<{ deleted: boolean; cancelled: boolean }> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const row = await loadRow(tx, workspaceId, id);
    if (row.status === "draft" || row.status === "failed" || row.status === "cancelled") {
      await tx.socialPublication.delete({ where: { id: row.id, workspaceId } });
      return { deleted: true, cancelled: false };
    }
    if (row.status === "pending_approval" || row.status === "approved") {
      await tx.socialPublication.update({ where: { id: row.id, workspaceId }, data: { status: "cancelled" } });
      return { deleted: false, cancelled: true };
    }
    if (row.status === "scheduled") {
      // Already with the provider: we stop tracking it here; the provider
      // copy is removed by the route (best effort) before calling this.
      await tx.socialPublication.update({ where: { id: row.id, workspaceId }, data: { status: "cancelled" } });
      return { deleted: false, cancelled: true };
    }
    throw new ConflictError("Published posts can't be deleted here. Remove them on the platform.");
  });
}

export interface ListOptions {
  from?: Date;
  to?: Date;
  status?: SocialPublicationStatus;
  limit?: number;
}

/**
 * Posts for the table and calendar. A post's calendar date is its publish
 * time, else its schedule, else its creation; the window filters on that.
 */
export async function listPosts(workspaceId: string, opts: ListOptions = {}): Promise<SerializedPost[]> {
  const take = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  return withWorkspaceScope(workspaceId, async (tx) => {
    const range = opts.from || opts.to ? { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) } : null;
    const rows = await tx.socialPublication.findMany({
      where: {
        workspaceId,
        ...(opts.status ? { status: opts.status } : {}),
        ...(range
          ? {
              OR: [
                { publishedAt: range },
                { publishedAt: null, scheduledFor: range },
                { publishedAt: null, scheduledFor: null, createdAt: range },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take,
    });
    const totals = await metricTotals(tx, workspaceId, rows.map((r) => r.id));
    return rows.map((r) => serializePost(r, totals.get(r.id) ?? null));
  });
}

async function metricTotals(tx: Tx, workspaceId: string, ids: string[]): Promise<Map<string, PostMetricsTotals>> {
  const out = new Map<string, PostMetricsTotals>();
  if (ids.length === 0) return out;
  const rows = await tx.socialPostMetric.findMany({
    where: { workspaceId, publicationId: { in: ids } },
    select: { publicationId: true, impressions: true, likes: true, comments: true, shares: true, clicks: true, source: true },
  });
  for (const r of rows) {
    const t = out.get(r.publicationId) ?? { impressions: 0, likes: 0, comments: 0, shares: 0, clicks: 0, engagements: 0, mock: false };
    t.impressions += r.impressions;
    t.likes += r.likes;
    t.comments += r.comments;
    t.shares += r.shares;
    t.clicks += r.clicks;
    t.engagements = t.likes + t.comments + t.shares + t.clicks;
    t.mock = t.mock || r.source === "mock";
    out.set(r.publicationId, t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validation before submit / dispatch
// ---------------------------------------------------------------------------

/** Every problem that would stop this post from publishing (empty = OK). */
export function publishProblems(post: SerializedPost, now: Date = new Date()): string[] {
  const problems: string[] = [];
  if (!post.content.trim() && post.media.length === 0) problems.push("Write something or attach media.");
  if (post.channels.length === 0) problems.push("Pick at least one channel.");
  if (post.publishMode === "schedule") {
    if (!post.scheduledFor) problems.push("Pick a time to schedule the post.");
    else if (new Date(post.scheduledFor).getTime() <= now.getTime()) problems.push("The scheduled time is in the past.");
  }
  // Length is checked on the body each platform will actually receive.
  for (const c of post.channels) {
    const body = buildChannelBody({ content: post.content, link: post.link, platform: c.identifier, campaign: post.utmCampaign, postId: post.id, at: now });
    for (const issue of validatePost([c.identifier], body, post.media)) {
      if (!problems.includes(issue.message)) problems.push(issue.message);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export async function submitForApproval(
  workspaceId: string,
  id: string,
  userId: string,
  now: Date = new Date(),
): Promise<SerializedPost> {
  const post = await withWorkspaceScope(workspaceId, async (tx) => {
    const row = await loadRow(tx, workspaceId, id);
    if (!EDITABLE.includes(row.status)) throw new ConflictError("This post was already submitted.");
    const problems = publishProblems(serializePost(row), now);
    if (problems.length) throw new BadRequestError(problems.join(" "), { code: "post_invalid" });
    const claimed = await tx.socialPublication.updateMany({
      where: { id: row.id, workspaceId, status: { in: EDITABLE } },
      data: { status: "pending_approval", requestedBy: userId, requestedAt: now, decidedBy: null, decidedAt: null, decisionNote: null, error: null },
    });
    if (claimed.count === 0) throw new ConflictError("This post was already submitted.");
    return serializePost(await loadRow(tx, workspaceId, id));
  });
  await notifyApprovalNeeded({
    workspaceId,
    source: "social",
    sourceId: post.id,
    title: postTitle(post),
    href: `/dashboard/social?post=${encodeURIComponent(post.id)}`,
    requestedBy: userId,
  });
  return post;
}

export interface Decider {
  userId: string;
  role: WorkspaceRole;
  hasOtherApprover: boolean;
}

/** Same rule the inbox shows: editor+, not your own request unless you're the only approver. */
export function canDecide(post: { requestedBy: string | null }, d: Decider): { ok: boolean; reason: string | null } {
  if (!roleAtLeast(d.role, "editor")) return { ok: false, reason: "Needs an editor or above to decide." };
  if (post.requestedBy === d.userId && d.hasOtherApprover) {
    return { ok: false, reason: "Someone else approves posts you submit." };
  }
  return { ok: true, reason: null };
}

export async function decidePost(
  workspaceId: string,
  id: string,
  decider: Decider,
  decision: "approve" | "deny",
  note: string | null,
  provider: SocialProvider | null,
  now: Date = new Date(),
): Promise<SerializedPost> {
  const decided = await withWorkspaceScope(workspaceId, async (tx) => {
    const row = await loadRow(tx, workspaceId, id);
    if (row.status !== "pending_approval") throw new ConflictError("This post isn't waiting for approval.");
    const gate = canDecide(row, decider);
    if (!gate.ok) throw new ForbiddenError(gate.reason ?? "You can't decide this post.");
    if (decision === "approve") {
      const problems = publishProblems(serializePost(row), now);
      if (problems.length) throw new BadRequestError(problems.join(" "), { code: "post_invalid" });
    }
    const claimed = await tx.socialPublication.updateMany({
      where: { id: row.id, workspaceId, status: "pending_approval" },
      data:
        decision === "approve"
          ? { status: "approved", decidedBy: decider.userId, decidedAt: now, decisionNote: note }
          : { status: "draft", decidedBy: decider.userId, decidedAt: now, decisionNote: note || "Changes requested." },
    });
    if (claimed.count === 0) throw new ConflictError("This post was already decided.");
    return loadRow(tx, workspaceId, id);
  });
  await notifyApprovalDecided({
    workspaceId,
    source: "social",
    sourceId: decided.id,
    title: postTitle(decided),
    decision: decision === "approve" ? "approved" : "denied",
    decidedBy: decider.userId,
    requestedBy: decided.requestedBy,
    href: `/dashboard/social?post=${encodeURIComponent(decided.id)}`,
  });
  if (decision === "deny") return serializePost(decided);
  if (!provider) {
    return failPost(workspaceId, decided.id, "Social publishing isn't connected. Connect Postiz, then resubmit.");
  }
  return dispatchPost(workspaceId, decided.id, provider, now);
}

async function failPost(workspaceId: string, id: string, message: string): Promise<SerializedPost> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const row = await tx.socialPublication.update({ where: { id, workspaceId }, data: { status: "failed", error: message.slice(0, 500) } });
    return serializePost(row);
  });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Hand an approved post to the provider. Atomic claim (approved → scheduled)
 * so a double click or a concurrent sweep can't create duplicate posts.
 * "now" posts on the mock provider publish immediately; on Postiz the post
 * stays "scheduled" until refreshStatuses() sees Postiz report it published.
 */
export async function dispatchPost(
  workspaceId: string,
  id: string,
  provider: SocialProvider,
  now: Date = new Date(),
): Promise<SerializedPost> {
  const claimed = await withWorkspaceScope(workspaceId, async (tx) => {
    const res = await tx.socialPublication.updateMany({
      where: { id, workspaceId, status: "approved" },
      data: { status: "scheduled", provider: provider.name, error: null },
    });
    return res.count === 1 ? loadRow(tx, workspaceId, id) : null;
  });
  if (!claimed) {
    return withWorkspaceScope(workspaceId, async (tx) => serializePost(await loadRow(tx, workspaceId, id)));
  }
  const post = serializePost(claimed);
  try {
    // Postiz wants channels the account actually has; re-check at dispatch.
    const live = new Map((await provider.listChannels()).map((c: ProviderChannel) => [c.id, c]));
    const missing = post.channels.filter((c) => !live.has(c.id));
    if (missing.length) {
      throw new BadRequestError(`Not connected anymore: ${missing.map((c) => c.name).join(", ")}. Reconnect them or pick other channels.`);
    }
    const mediaRefs = [];
    for (const m of post.media) {
      const file = await readFile({ workspaceId, fileId: m.fileId });
      if (!file) throw new BadRequestError(`Media ${m.filename} is missing. Upload it again.`);
      mediaRefs.push(await provider.uploadMedia({ bytes: file.bytes, filename: file.meta.filename, mimeType: file.meta.mimeType }));
    }
    const schedule = post.publishMode === "schedule" && post.scheduledFor && new Date(post.scheduledFor).getTime() > now.getTime();
    const publishAt = schedule ? new Date(post.scheduledFor!) : now;
    // The campaign every link carries; stored so attribution can join on it.
    const campaign = slugCampaign(post.utmCampaign) ?? defaultCampaign(publishAt);
    const refs = await provider.createPosts({
      type: schedule ? "schedule" : "now",
      date: schedule ? post.scheduledFor! : undefined,
      posts: post.channels.map((c) => ({
        channel: { id: c.id, identifier: live.get(c.id)?.identifier ?? c.identifier },
        body: buildChannelBody({ content: post.content, link: post.link, platform: c.identifier, campaign, postId: post.id, at: publishAt }),
      })),
      media: mediaRefs,
    });
    if (refs.length === 0) throw new Error("The provider accepted the post but returned no post ids.");
    const byIntegration = new Map(post.channels.map((c) => [c.id, c]));
    const stored: ProviderRef[] = refs.map((r) => ({
      postId: r.postId,
      integrationId: r.integrationId,
      platform: normalizePlatform(byIntegration.get(r.integrationId)?.identifier ?? ""),
      state: "queued",
      releaseUrl: null,
    }));
    const publishNow = !schedule && provider.name === "mock";
    const row = await withWorkspaceScope(workspaceId, (tx) =>
      tx.socialPublication.update({
        where: { id: post.id, workspaceId },
        data: {
          providerRefs: json(stored.map((s) => (publishNow ? { ...s, state: "published" } : s))),
          scheduledFor: publishAt,
          utmCampaign: campaign,
          ...(publishNow ? { status: "published" as const, publishedAt: now } : {}),
        },
      }),
    );
    if (publishNow) await emitPublished(workspaceId, row);
    return serializePost(row);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Dispatch failed.";
    log.warn("social dispatch failed", { workspaceId, postId: post.id, provider: provider.name, error: message });
    return failPost(workspaceId, post.id, message);
  }
}

async function emitPublished(workspaceId: string, row: SocialPublication): Promise<void> {
  const refs = readRefs(row.providerRefs);
  await emitWebhookEvent({
    workspaceId,
    type: "social_post.published",
    data: {
      id: row.id,
      title: postTitle(row),
      platforms: [...new Set(readChannels(row.channels).map((c) => normalizePlatform(c.identifier)))],
      mediaCount: readMedia(row.media).length,
      link: row.link,
      utmCampaign: row.utmCampaign,
      source: row.source,
      provider: row.provider,
      releaseUrls: refs.map((r) => r.releaseUrl).filter((u): u is string => !!u),
      publishedAt: (row.publishedAt ?? new Date()).toISOString(),
    },
    dedupKey: `social_post.published:${row.id}`,
  });
}

// ---------------------------------------------------------------------------
// Status refresh (scheduled → published / failed)
// ---------------------------------------------------------------------------

export interface RefreshResult {
  checked: number;
  published: number;
  failed: number;
}

export async function refreshStatuses(
  workspaceId: string,
  provider: SocialProvider,
  now: Date = new Date(),
): Promise<RefreshResult> {
  const result: RefreshResult = { checked: 0, published: 0, failed: 0 };
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.socialPublication.findMany({
      where: { workspaceId, status: "scheduled", provider: provider.name, scheduledFor: { lte: now } },
      orderBy: { scheduledFor: "asc" },
      take: 100,
    }),
  );
  if (rows.length === 0) return result;
  // Crashed dispatches: claimed long ago, never got provider refs.
  const stale = rows.filter((r) => readRefs(r.providerRefs).length === 0);
  for (const r of stale) {
    if (now.getTime() - r.updatedAt.getTime() > STALE_DISPATCH_MS) {
      await failPost(workspaceId, r.id, "Dispatch was interrupted. Resubmit the post.");
      result.failed++;
    }
  }
  const live = rows.filter((r) => readRefs(r.providerRefs).length > 0);
  if (live.length === 0) return result;
  const ids = live.flatMap((r) => readRefs(r.providerRefs).map((x) => x.postId));
  const earliest = Math.min(...live.map((r) => (r.scheduledFor ?? r.createdAt).getTime()));
  let statuses: Map<string, ProviderPostStatus>;
  try {
    statuses = await provider.postStatuses(ids, {
      from: new Date(earliest - 86_400_000),
      to: new Date(now.getTime() + 86_400_000),
    });
  } catch (e) {
    log.warn("social status refresh failed", { workspaceId, error: e instanceof Error ? e.message : String(e) });
    return result;
  }
  for (const r of live) {
    result.checked++;
    const refs = readRefs(r.providerRefs).map((ref) => {
      const s = statuses.get(ref.postId);
      return s ? { ...ref, state: s.state, releaseUrl: s.releaseUrl ?? ref.releaseUrl ?? null } : ref;
    });
    const anyError = refs.some((x) => x.state === "error");
    const allPublished = refs.every((x) => x.state === "published");
    if (!anyError && !allPublished) {
      await withWorkspaceScope(workspaceId, (tx) => tx.socialPublication.update({ where: { id: r.id, workspaceId }, data: { providerRefs: json(refs) } }));
      continue;
    }
    const publishedTimes = refs
      .map((x) => statuses.get(x.postId)?.publishedAt)
      .filter((t): t is string => !!t)
      .map((t) => new Date(t).getTime())
      .filter(Number.isFinite);
    const row = await withWorkspaceScope(workspaceId, (tx) =>
      tx.socialPublication.update({
        where: { id: r.id, workspaceId },
        data: anyError
          ? { providerRefs: json(refs), status: "failed", error: "The platform rejected the post. Check the channel in Postiz, then resubmit." }
          : {
              providerRefs: json(refs),
              status: "published",
              publishedAt: publishedTimes.length ? new Date(Math.max(...publishedTimes)) : now,
            },
      }),
    );
    if (anyError) result.failed++;
    else {
      result.published++;
      await emitPublished(workspaceId, row);
    }
  }
  return result;
}
