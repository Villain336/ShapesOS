// Marketr — social scheduling service (milestone 20).
//
// Prisma-backed orchestration for the Buffer connection, channels, posts,
// dispatch (with idempotency + bounded retries), status refresh, and analytics
// pull-back. Buffer I/O goes through the injected BufferPort (real API in
// production, MockBufferPort in tests). Pure validation/bucketing lives in
// ./channels.ts.

import type { Prisma, PrismaClient } from "@prisma/client";
import { secrets } from "@/lib/secrets";
import { emitAlert } from "@/lib/alerts/evaluate";
import {
  ALL_SERVICES,
  CHANNEL_DEFS,
  MAX_DISPATCH_ATTEMPTS,
  buildUtmUrl,
  nextRetryAt,
  resolveChannelContent,
  validatePostForChannels,
  type SocialContent,
  type SocialService,
} from "./channels";
import { isTransientBufferError, type BufferPort } from "./buffer";

type Db = PrismaClient;

type AuditAction =
  | "social_buffer_key_updated"
  | "social_buffer_key_revoked"
  | "social_channels_synced"
  | "social_channel_enabled"
  | "social_channel_disabled"
  | "social_post_created"
  | "social_post_updated"
  | "social_post_scheduled"
  | "social_post_sent"
  | "social_post_failed"
  | "social_post_cancelled"
  | "social_post_deleted"
  | "social_analytics_synced";

/** Shared audit helper — every social mutation is audit-logged. */
export async function auditSocial(
  db: Db,
  workspaceId: string,
  projectId: string | null,
  action: AuditAction,
  summary: string,
  actor: "user" | "system" = "user",
): Promise<void> {
  await db.fileChangeLog.create({
    data: {
      workspaceId,
      projectId: projectId ?? "",
      connectionId: null,
      filePath: "",
      actor,
      action,
      summary: summary.slice(0, 280),
    },
  });
}

/** Normalize the Buffer service key to our SocialService union (best effort). */
export function normalizeService(service: string): SocialService | null {
  const s = service.trim().toLowerCase();
  if ((ALL_SERVICES as string[]).includes(s)) return s as SocialService;
  const aliases: Record<string, SocialService> = {
    x: "twitter",
    fb: "facebook",
    ig: "instagram",
  };
  return aliases[s] ?? null;
}

// ---------------------------------------------------------------------------
// Settings — BYO Buffer access token (encrypted, never returned to clients)
// ---------------------------------------------------------------------------

export async function getSocialSettings(db: Db, workspaceId: string) {
  return db.socialSettings.findUnique({ where: { workspaceId } });
}

export async function hasBufferToken(db: Db, workspaceId: string): Promise<boolean> {
  const s = await getSocialSettings(db, workspaceId);
  return !!s?.bufferTokenEnc;
}

export async function setBufferToken(
  db: Db,
  workspaceId: string,
  token: string,
  actor: "user" | "system" = "user",
): Promise<{ hint: string }> {
  const clean = token.trim();
  if (!clean) throw new Error("Buffer access token is required.");
  const enc = secrets().encrypt(clean);
  const hint = secrets().hint(clean);
  await db.socialSettings.upsert({
    where: { workspaceId },
    update: { bufferTokenEnc: enc, bufferTokenHint: hint },
    create: { workspaceId, bufferTokenEnc: enc, bufferTokenHint: hint },
  });
  await auditSocial(db, workspaceId, null, "social_buffer_key_updated", `Buffer access token updated (${hint}).`, actor);
  return { hint };
}

export async function revokeBufferToken(
  db: Db,
  workspaceId: string,
  actor: "user" | "system" = "user",
): Promise<void> {
  await db.socialSettings.upsert({
    where: { workspaceId },
    update: { bufferTokenEnc: null, bufferTokenHint: null },
    create: { workspaceId },
  });
  await auditSocial(db, workspaceId, null, "social_buffer_key_revoked", "Buffer access token revoked.", actor);
}

/** Live Buffer port for the workspace, or null when no token is configured. */
export async function getBufferPort(
  db: Db,
  workspaceId: string,
  factory: (token: string) => BufferPort,
): Promise<BufferPort | null> {
  const settings = await db.socialSettings.findUnique({ where: { workspaceId } });
  if (!settings?.bufferTokenEnc) return null;
  return factory(secrets().decrypt(settings.bufferTokenEnc));
}

// ---------------------------------------------------------------------------
// Channels — Buffer profiles synced into the project
// ---------------------------------------------------------------------------

export interface SyncedChannel {
  id: string;
  bufferProfileId: string;
  service: SocialService | null;
  label: string;
  handle: string | null;
  enabled: boolean;
}

/** Sync Buffer profiles into SocialChannel rows (preserves enable flags). */
export async function syncChannels(
  db: Db,
  projectId: string,
  workspaceId: string,
  port: BufferPort,
  actor: "user" | "system" = "user",
): Promise<SyncedChannel[]> {
  const profiles = await port.listProfiles();
  const rows = await Promise.all(
    profiles.map((p) =>
      db.socialChannel.upsert({
        where: { projectId_bufferProfileId: { projectId, bufferProfileId: p.id } },
        update: {
          service: normalizeService(p.service) ?? p.service,
          handle: p.formattedUsername ?? p.serviceUsername ?? null,
        },
        create: {
          projectId,
          bufferProfileId: p.id,
          service: normalizeService(p.service) ?? p.service,
          handle: p.formattedUsername ?? p.serviceUsername ?? null,
          enabled: true,
        },
      }),
    ),
  );
  await auditSocial(
    db,
    workspaceId,
    projectId,
    "social_channels_synced",
    `Synced ${rows.length} Buffer channel${rows.length === 1 ? "" : "s"}.`,
    actor,
  );
  return rows.map((r) => ({
    id: r.id,
    bufferProfileId: r.bufferProfileId,
    service: normalizeService(r.service),
    label: CHANNEL_DEFS[normalizeService(r.service) as SocialService]?.label ?? r.service,
    handle: r.handle,
    enabled: r.enabled,
  }));
}

export async function setChannelEnabled(
  db: Db,
  workspaceId: string,
  channelId: string,
  enabled: boolean,
  actor: "user" | "system" = "user",
): Promise<void> {
  const row = await db.socialChannel.update({ where: { id: channelId }, data: { enabled } });
  await auditSocial(
    db,
    workspaceId,
    row.projectId,
    enabled ? "social_channel_enabled" : "social_channel_disabled",
    `Channel ${row.handle ?? row.service} ${enabled ? "enabled" : "disabled"}.`,
    actor,
  );
}

// ---------------------------------------------------------------------------
// Posts — drafts, scheduling, dispatch, cancel
// ---------------------------------------------------------------------------

export interface DispatchEntry {
  channelId: string;
  profileId: string;
  updateId: string;
  service: string;
}

function readDispatchEntries(raw: unknown): DispatchEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is DispatchEntry =>
      !!e && typeof (e as DispatchEntry).updateId === "string" && typeof (e as DispatchEntry).profileId === "string",
  );
}

/**
 * Server-side guardrail for scheduling: every target service must resolve to
 * a connected + enabled channel in this project.
 */
export async function resolveTargetChannels(
  db: Db,
  projectId: string,
  services: SocialService[],
): Promise<{ channels: Array<{ id: string; bufferProfileId: string; service: SocialService }>; missing: SocialService[] }> {
  const rows = await db.socialChannel.findMany({
    where: { projectId, enabled: true },
  });
  const byService = new Map<SocialService, { id: string; bufferProfileId: string; service: SocialService }>();
  for (const r of rows) {
    const svc = normalizeService(r.service);
    if (svc && !byService.has(svc)) byService.set(svc, { id: r.id, bufferProfileId: r.bufferProfileId, service: svc });
  }
  const channels: Array<{ id: string; bufferProfileId: string; service: SocialService }> = [];
  const missing: SocialService[] = [];
  for (const s of services) {
    const c = byService.get(s);
    if (c) channels.push(c);
    else missing.push(s);
  }
  return { channels, missing };
}

export function sanitizeContent(input: unknown): SocialContent {
  const c = (input ?? {}) as Partial<SocialContent>;
  const perChannel: SocialContent["perChannel"] = {};
  if (c.perChannel && typeof c.perChannel === "object") {
    for (const svc of ALL_SERVICES) {
      const o = (c.perChannel as Record<string, unknown>)[svc] as
        | { text?: unknown; media?: unknown }
        | undefined;
      if (o && typeof o === "object") {
        perChannel[svc] = {
          text: typeof o.text === "string" ? o.text : undefined,
          media: Array.isArray(o.media)
            ? o.media
                .filter((m): m is { type: string; url: string } => !!m && typeof (m as { url?: unknown }).url === "string")
                .map((m) => ({
                  type: m.type === "video" ? ("video" as const) : m.type === "link" ? ("link" as const) : ("image" as const),
                  url: String(m.url),
                }))
            : undefined,
        };
      }
    }
  }
  return {
    text: typeof c.text === "string" ? c.text : "",
    perChannel,
    media: Array.isArray(c.media)
      ? c.media
          .filter((m) => !!m && typeof m.url === "string")
          .map((m) => ({
            type: m.type === "video" ? ("video" as const) : m.type === "link" ? ("link" as const) : ("image" as const),
            url: String(m.url),
          }))
      : [],
    link: typeof c.link === "string" && c.link.trim() ? c.link.trim() : undefined,
    utm:
      c.utm && typeof c.utm === "object"
        ? Object.fromEntries(
            Object.entries(c.utm as Record<string, unknown>).filter(([, v]) => typeof v === "string" && v.trim()),
          )
        : undefined,
  };
}

export async function createPost(
  db: Db,
  workspaceId: string,
  projectId: string,
  args: { content: unknown; services: string[]; scheduledFor?: string | null },
  actor: "user" | "system" = "user",
) {
  const content = sanitizeContent(args.content);
  const services = [...new Set(args.services.map((s) => normalizeService(s)).filter((s): s is SocialService => !!s))];
  if (services.length === 0) throw new Error("Select at least one social channel.");
  const post = await db.socialPost.create({
    data: {
      projectId,
      content: content as unknown as Prisma.InputJsonValue,
      services,
      scheduledFor: args.scheduledFor ? new Date(args.scheduledFor) : null,
      status: "draft",
    },
  });
  await auditSocial(db, workspaceId, projectId, "social_post_created", `Social post drafted (${services.join(", ")}).`, actor);
  return post;
}

export async function updatePost(
  db: Db,
  workspaceId: string,
  postId: string,
  args: { content?: unknown; services?: string[]; scheduledFor?: string | null },
  actor: "user" | "system" = "user",
) {
  const post = await db.socialPost.findUniqueOrThrow({ where: { id: postId } });
  if (post.status !== "draft") throw new Error("Only drafts can be edited.");
  const data: Prisma.SocialPostUpdateInput = {};
  if (args.content !== undefined) data.content = sanitizeContent(args.content) as unknown as Prisma.InputJsonValue;
  if (args.services !== undefined) {
    const services = [...new Set(args.services.map((s) => normalizeService(s)).filter((s): s is SocialService => !!s))];
    if (services.length === 0) throw new Error("Select at least one social channel.");
    data.services = services;
  }
  if (args.scheduledFor !== undefined) data.scheduledFor = args.scheduledFor ? new Date(args.scheduledFor) : null;
  const updated = await db.socialPost.update({ where: { id: postId }, data });
  await auditSocial(db, workspaceId, post.projectId, "social_post_updated", "Social post draft updated.", actor);
  return updated;
}

export async function deletePost(db: Db, workspaceId: string, postId: string, actor: "user" | "system" = "user") {
  const post = await db.socialPost.findUniqueOrThrow({ where: { id: postId } });
  if (post.status !== "draft" && post.status !== "failed") {
    throw new Error("Only draft or failed posts can be deleted — cancel scheduled posts first.");
  }
  await db.socialPost.delete({ where: { id: postId } });
  await auditSocial(db, workspaceId, post.projectId, "social_post_deleted", "Social post deleted.", actor);
}

/**
 * Dispatch a post to Buffer (idempotent). Creates one Buffer update per
 * channel so per-channel text overrides are honored. On success the post's
 * bufferUpdateIds are stored; a second call with the same targets creates
 * nothing new.
 */
export async function dispatchPost(
  db: Db,
  workspaceId: string,
  projectId: string,
  postId: string,
  port: BufferPort,
  opts: { now?: boolean; actor?: "user" | "system" } = {},
): Promise<{ dispatched: DispatchEntry[]; alreadyDispatched: boolean }> {
  const actor = opts.actor ?? "user";
  const post = await db.socialPost.findUniqueOrThrow({ where: { id: postId } });
  if (post.projectId !== projectId) throw new Error("Post does not belong to this project.");

  // Day-1 fix (edge #7): atomic claim. The old read-then-dispatch let two
  // concurrent runs (manual send + cron, or overlapping crons) both see an
  // empty bufferUpdateIds and create duplicate Buffer updates. Exactly one
  // dispatcher can hold the claim; the loser aborts before touching Buffer.
  // Dispatchable statuses mirror the publish-now route (draft/failed) plus
  // the cron's scheduled.
  const claimed = await db.socialPost.updateMany({
    where: { id: postId, status: { in: ["draft", "scheduled", "failed"] } },
    data: { status: "dispatching" },
  });
  if (claimed.count === 0) {
    const cur = await db.socialPost.findUniqueOrThrow({
      where: { id: postId },
      select: { status: true },
    });
    if (cur.status === "sent") throw new Error("Post already sent.");
    if (cur.status === "cancelled") throw new Error("Post was cancelled.");
    // Benign race: another dispatcher holds the claim. Callers recognize
    // this via err.code === "DISPATCH_CLAIM_LOST" and must not treat it as
    // a failure or bump retry attempts.
    const err = new Error("Post dispatch already in progress.") as Error & { code?: string };
    err.code = "DISPATCH_CLAIM_LOST";
    throw err;
  }

  const releaseClaim = () =>
    db.socialPost.updateMany({
      where: { id: postId, status: "dispatching" },
      data: { status: "scheduled" },
    });

  try {
    const services = (post.services as string[]).map((s) => normalizeService(s)).filter((s): s is SocialService => !!s);
    const { channels, missing } = await resolveTargetChannels(db, projectId, services);
    if (missing.length > 0) {
      const labels = missing.map((s) => CHANNEL_DEFS[s]?.label ?? s).join(", ");
      throw new Error(`Not connected or disabled: ${labels}. Sync channels and enable them first.`);
    }

    const content = sanitizeContent(post.content);
    const issues = validatePostForChannels(services, content);
    if (issues.length > 0) {
      throw new Error(issues.map((i) => i.message).join(" "));
    }

    const existing = readDispatchEntries(post.bufferUpdateIds);
    const existingByProfile = new Map(existing.map((e) => [e.profileId, e]));
    const dispatched: DispatchEntry[] = [...existing];

    for (const ch of channels) {
      if (existingByProfile.has(ch.bufferProfileId)) continue; // idempotent: already queued
      const resolved = resolveChannelContent(content, ch.service);
      const link = buildUtmUrl(content.link, content.utm);
      const photo = resolved.media.find((m) => m.type === "image")?.url;
      try {
        const update = await port.createUpdate(ch.bufferProfileId, {
          text: resolved.text.trim(),
          link,
          photo,
          scheduledAt: opts.now ? undefined : post.scheduledFor?.toISOString(),
          now: opts.now,
        });
        dispatched.push({ channelId: ch.id, profileId: ch.bufferProfileId, updateId: update.id, service: ch.service });
      } catch (err) {
        throw annotateDispatchError(err);
      }
      // Day-1 fix (edge #9): persist update ids incrementally. A failure on a
      // later channel used to orphan the already-created Buffer updates — the
      // retry then created duplicates. Now each created update is durable
      // before the next channel is attempted, and retries skip them.
      await db.socialPost.update({
        where: { id: postId },
        data: { bufferUpdateIds: dispatched as unknown as Prisma.InputJsonValue },
      });
    }

    const alreadyDispatched = dispatched.length === existing.length && existing.length > 0;
    await db.socialPost.update({
      where: { id: postId },
      data: {
        bufferUpdateIds: dispatched as unknown as Prisma.InputJsonValue,
        status: "scheduled",
        attempts: 0,
        nextAttemptAt: null,
        error: null,
      },
    });
    if (!alreadyDispatched) {
      await auditSocial(
        db,
        workspaceId,
        projectId,
        "social_post_scheduled",
        `Social post queued via Buffer (${dispatched.length} channel${dispatched.length === 1 ? "" : "s"}).`,
        actor,
      );
    }
    return { dispatched, alreadyDispatched };
  } catch (err) {
    // Release the atomic claim so retries / the next cron sweep can proceed.
    await releaseClaim().catch(() => {});
    throw err;
  }
}

function annotateDispatchError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  const e = new Error(`Buffer dispatch failed: ${message}`);
  (e as { status?: number }).status = (err as { status?: number })?.status;
  (e as { transient?: boolean }).transient = isTransientBufferError(err);
  return e;
}

interface DispatchRow {
  id: string;
  projectId: string;
  status: string;
  scheduledFor: Date | null;
  attempts: number;
  services: unknown;
  content: unknown;
  bufferUpdateIds: unknown;
}

/** One dispatch attempt with bounded retry bookkeeping. Used by cron + manual schedule. */
export async function attemptDispatch(
  db: Db,
  workspaceId: string,
  row: DispatchRow,
  port: BufferPort,
  actor: "user" | "system" = "system",
): Promise<{ outcome: "dispatched" | "retrying" | "failed" | "skipped"; error?: string }> {
  try {
    await dispatchPost(db, workspaceId, row.projectId, row.id, port, { actor });
    return { outcome: "dispatched" };
  } catch (err) {
    // Day-1 (edge #7): lost the dispatch claim to another worker. Not a
    // failure — the claim holder is doing the send. Leave attempts/backoff
    // untouched so we don't pollute the retry state of a healthy post.
    if ((err as { code?: string })?.code === "DISPATCH_CLAIM_LOST") {
      return { outcome: "skipped", error: err instanceof Error ? err.message : String(err) };
    }
    const transient = (err as { transient?: boolean })?.transient ?? isTransientBufferError(err);
    const message = err instanceof Error ? err.message : String(err);
    const attempts = row.attempts + 1;
    if (transient && attempts < MAX_DISPATCH_ATTEMPTS) {
      await db.socialPost.update({
        where: { id: row.id },
        data: { attempts, nextAttemptAt: nextRetryAt(attempts), error: message },
      });
      await auditSocial(db, workspaceId, row.projectId, "social_post_failed", `Social post dispatch attempt ${attempts} failed (retrying): ${message.slice(0, 180)}`, actor);
      return { outcome: "retrying", error: message };
    }
    await db.socialPost.update({
      where: { id: row.id },
      data: { attempts, nextAttemptAt: null, status: "failed", error: message },
    });
    await auditSocial(db, workspaceId, row.projectId, "social_post_failed", `Social post failed: ${message.slice(0, 180)}`, actor);
    try {
      await emitAlert({
        workspaceId,
        projectId: row.projectId,
        trigger: "social_post_failed",
        severity: "critical",
        title: "Social post failed to publish",
        body: message,
        link: `/dashboard/projects/${row.projectId}/social`,
        dedupKey: `social_post_failed:${row.id}:${attempts}`,
      });
    } catch {
      // alert failures never break the dispatch path
    }
    return { outcome: "failed", error: message };
  }
}

/** Cancel: remove pending Buffer updates, mark cancelled. */
export async function cancelPost(
  db: Db,
  workspaceId: string,
  postId: string,
  port: BufferPort | null,
  actor: "user" | "system" = "user",
): Promise<void> {
  const post = await db.socialPost.findUniqueOrThrow({ where: { id: postId } });
  if (post.status !== "scheduled" && post.status !== "failed") {
    throw new Error("Only scheduled or failed posts can be cancelled.");
  }
  const entries = readDispatchEntries(post.bufferUpdateIds);
  if (port) {
    for (const e of entries) {
      try {
        await port.deleteUpdate(e.updateId);
      } catch {
        // Best effort: the update may already be sent or expired.
      }
    }
  }
  await db.socialPost.update({
    where: { id: postId },
    data: { status: "cancelled" },
  });
  await auditSocial(db, workspaceId, post.projectId, "social_post_cancelled", "Social post cancelled.", actor);
}

/** Refresh sent status: a dispatched post whose Buffer updates are all sent → sent. */
export async function refreshPostStatus(
  db: Db,
  workspaceId: string,
  postId: string,
  port: BufferPort,
  actor: "user" | "system" = "user",
): Promise<{ status: string; sentCount: number; total: number }> {
  const post = await db.socialPost.findUniqueOrThrow({ where: { id: postId } });
  const entries = readDispatchEntries(post.bufferUpdateIds);
  if (entries.length === 0) return { status: post.status, sentCount: 0, total: 0 };
  let sentCount = 0;
  for (const e of entries) {
    try {
      const u = await port.getUpdate(e.updateId);
      if (u.status === "sent") sentCount += 1;
    } catch {
      // Leave as-is on lookup failure.
    }
  }
  if (sentCount === entries.length && post.status !== "sent") {
    await db.socialPost.update({ where: { id: postId }, data: { status: "sent" } });
    await auditSocial(db, workspaceId, post.projectId, "social_post_sent", "Social post published by Buffer.", actor);
  }
  return { status: sentCount === entries.length ? "sent" : post.status, sentCount, total: entries.length };
}

// ---------------------------------------------------------------------------
// Analytics — per-post engagement pull-back (cached)
// ---------------------------------------------------------------------------

export async function syncAnalytics(
  db: Db,
  workspaceId: string,
  postId: string,
  port: BufferPort,
  actor: "user" | "system" = "user",
): Promise<Record<string, unknown>> {
  const post = await db.socialPost.findUniqueOrThrow({ where: { id: postId } });
  const entries = readDispatchEntries(post.bufferUpdateIds);
  const stats: Record<string, Record<string, number | undefined>> = {};
  const totals: Record<string, number> = { likes: 0, shares: 0, comments: 0, clicks: 0 };
  for (const e of entries) {
    try {
      const i = await port.getInteractions(e.updateId);
      stats[e.service] = { likes: i.likes, shares: i.shares, comments: i.comments, clicks: i.clicks };
      for (const k of Object.keys(totals)) totals[k] += i[k as keyof typeof i] ?? 0;
    } catch {
      // Best effort per channel.
    }
  }
  const payload = { byChannel: stats, totals, syncedAt: new Date().toISOString() };
  await db.socialPost.update({
    where: { id: postId },
    data: { stats: payload as unknown as Prisma.InputJsonValue, statsSyncedAt: new Date() },
  });
  await auditSocial(db, workspaceId, post.projectId, "social_analytics_synced", "Social post analytics refreshed.", actor);
  return payload;
}

// ---------------------------------------------------------------------------
// Cron sweep — dispatch due posts, retry backoff-due posts, refresh sent status
// ---------------------------------------------------------------------------

export interface CronSweepResult {
  dispatched: number;
  retrying: number;
  failed: number;
  markedSent: number;
}

export async function runDueSocialPosts(
  db: Db,
  portFactory: (workspaceId: string) => Promise<BufferPort | null>,
  onlyWorkspaceId?: string,
  actor: "user" | "system" = "system",
): Promise<CronSweepResult> {
  const now = new Date();
  const result: CronSweepResult = { dispatched: 0, retrying: 0, failed: 0, markedSent: 0 };

  // Day-1 fix (edge #7): reclaim stale dispatch claims. If a dispatcher
  // crashed between claiming and releasing, the post would sit in
  // "dispatching" forever (the sweep only selects "scheduled"). Claims older
  // than 15 minutes are safely returned to "scheduled" — the per-channel
  // idempotency in dispatchPost makes re-dispatch safe.
  await db.socialPost.updateMany({
    where: {
      ...(onlyWorkspaceId ? { project: { workspaceId: onlyWorkspaceId } } : {}),
      status: "dispatching",
      updatedAt: { lt: new Date(now.getTime() - 15 * 60_000) },
    },
    data: { status: "scheduled" },
  });

  // Candidates: user-scheduled posts that are due, plus transient failures
  // whose backoff has elapsed. BufferUpdateIds discrimination happens in JS
  // (empty = never dispatched; non-empty = handed to Buffer already).
  const candidates = await db.socialPost.findMany({
    where: {
      ...(onlyWorkspaceId ? { project: { workspaceId: onlyWorkspaceId } } : {}),
      status: "scheduled",
      OR: [{ scheduledFor: { lte: now } }, { nextAttemptAt: { lte: now } }],
    },
    include: { project: { select: { workspaceId: true } } },
  });

  const ports = new Map<string, BufferPort | null>();
  for (const row of candidates) {
    const wsId = row.project.workspaceId;
    if (!ports.has(wsId)) ports.set(wsId, await portFactory(wsId));
    const port = ports.get(wsId);
    if (!port) continue;

    if (readDispatchEntries(row.bufferUpdateIds).length === 0) {
      // Never dispatched: hand off to Buffer now. "skipped" means another
      // worker holds the dispatch claim — counted nowhere, not a failure.
      const outcome = await attemptDispatch(db, wsId, row, port, actor);
      if (outcome.outcome === "dispatched") result.dispatched += 1;
      else if (outcome.outcome === "retrying") result.retrying += 1;
      else if (outcome.outcome === "failed") result.failed += 1;
    } else if (row.scheduledFor && row.scheduledFor <= now && !row.nextAttemptAt) {
      // Dispatched and due: observe Buffer's publish status.
      const refreshed = await refreshPostStatus(db, wsId, row.id, port, actor);
      if (refreshed.status === "sent") result.markedSent += 1;
    }
  }

  return result;
}
