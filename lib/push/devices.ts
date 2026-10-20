// ShapesOS — mobile push devices (Phase 4b).
//
// One row per (workspace, Expo push token), owned by the user who registered
// it. Every function takes the withWorkspaceScope() transaction client
// (push_devices is FORCE RLS) and only ever touches the caller's own rows.
// Opt-out is per device (`enabled`) plus per notification kind (`mutedKinds`).

import type { Prisma, PrismaClient, PushDevice } from "@prisma/client";
import { BadRequestError, NotFoundError } from "@/lib/api/errors";
import { isExpoPushToken } from "./expo";

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * Notification kinds that can go out as push (Phase 3 producer kinds).
 * Phase 18.3 (WS=trust): every kind can — the person's channel matrix
 * (lib/notifications/channels.ts, Settings → You → Notifications) decides
 * which actually do. A device can still mute any of them.
 */
export const PUSH_KINDS = [
  "approval_needed",
  "approval_decided",
  "run_failed",
  // Phase 18.3 (WS=trust): the 18.2 and 18.3 kinds. Alerts and accepted
  // invites stay off the phone (team news, not something to act on now).
  "mention",
  "direct_message",
  "reminder_due",
  "run_finished",
  "invoice_paid",
  "ticket_assigned",
  "meeting_starting",
] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

export function isPushKind(v: unknown): v is PushKind {
  return typeof v === "string" && (PUSH_KINDS as readonly string[]).includes(v);
}

export const PUSH_PLATFORMS = ["ios", "android"] as const;
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

/** Devices kept per user per workspace (oldest by last-seen are dropped). */
export const MAX_DEVICES_PER_USER = 10;

export interface PushDeviceView {
  id: string;
  platform: string;
  deviceName: string | null;
  enabled: boolean;
  mutedKinds: string[];
  /** Last 6 characters of the token, to tell devices apart. Never the token. */
  tokenHint: string;
  lastSeenAt: string;
  lastSentAt: string | null;
  lastError: string | null;
}

export function toDeviceView(d: PushDevice): PushDeviceView {
  const inner = d.expoToken.replace(/^Expo(nent)?PushToken\[|\]$/g, "");
  return {
    id: d.id,
    platform: d.platform,
    deviceName: d.deviceName,
    enabled: d.enabled,
    mutedKinds: d.mutedKinds,
    tokenHint: inner.slice(-6),
    lastSeenAt: d.lastSeenAt.toISOString(),
    lastSentAt: d.lastSentAt ? d.lastSentAt.toISOString() : null,
    lastError: d.lastError,
  };
}

function cleanMuted(kinds: unknown): PushKind[] {
  if (!Array.isArray(kinds)) return [];
  return [...new Set(kinds.filter(isPushKind))];
}

export interface RegisterInput {
  workspaceId: string;
  userId: string;
  token: string;
  platform: string;
  deviceName?: string | null;
}

/**
 * Register (or refresh) this device for the caller. Re-registering keeps the
 * caller's own opt-out choices; a token that another member registered
 * before (a shared device signed into a new account) moves to the caller
 * with the defaults, so the previous user stops getting this device's pushes.
 */
export async function registerDevice(db: Db, input: RegisterInput): Promise<PushDeviceView> {
  if (!isExpoPushToken(input.token)) throw new BadRequestError("That isn't an Expo push token.");
  if (!(PUSH_PLATFORMS as readonly string[]).includes(input.platform)) {
    throw new BadRequestError("Platform must be ios or android.");
  }
  const deviceName = input.deviceName?.trim().slice(0, 80) || null;
  const key = { workspaceId: input.workspaceId, expoToken: input.token };
  const existing = await db.pushDevice.findUnique({ where: { workspaceId_expoToken: key } });
  const now = new Date();
  let row: PushDevice;
  if (existing && existing.userId === input.userId) {
    row = await db.pushDevice.update({
      where: { id: existing.id, workspaceId: input.workspaceId },
      data: { platform: input.platform, deviceName, lastSeenAt: now },
    });
  } else if (existing) {
    row = await db.pushDevice.update({
      where: { id: existing.id, workspaceId: input.workspaceId },
      data: {
        userId: input.userId,
        platform: input.platform,
        deviceName,
        enabled: true,
        mutedKinds: [],
        failureCount: 0,
        lastError: null,
        lastSentAt: null,
        lastSeenAt: now,
      },
    });
  } else {
    row = await db.pushDevice.create({
      data: { ...key, userId: input.userId, platform: input.platform, deviceName, lastSeenAt: now },
    });
  }
  // Keep the newest MAX_DEVICES_PER_USER registrations for this user.
  const stale = await db.pushDevice.findMany({
    where: { workspaceId: input.workspaceId, userId: input.userId },
    orderBy: [{ lastSeenAt: "desc" }, { id: "desc" }],
    skip: MAX_DEVICES_PER_USER,
    select: { id: true },
  });
  if (stale.length) {
    await db.pushDevice.deleteMany({ where: { workspaceId: input.workspaceId, id: { in: stale.map((s) => s.id) } } });
  }
  return toDeviceView(row);
}

export async function listDevices(db: Db, opts: { workspaceId: string; userId: string }): Promise<PushDeviceView[]> {
  const rows = await db.pushDevice.findMany({
    where: { workspaceId: opts.workspaceId, userId: opts.userId },
    orderBy: { lastSeenAt: "desc" },
    take: MAX_DEVICES_PER_USER,
  });
  return rows.map(toDeviceView);
}

/** Change the caller's own device preferences (opt out / mute kinds). */
export async function updateDevice(
  db: Db,
  opts: { workspaceId: string; userId: string; token: string; enabled?: boolean; mutedKinds?: unknown },
): Promise<PushDeviceView> {
  const existing = await db.pushDevice.findUnique({
    where: { workspaceId_expoToken: { workspaceId: opts.workspaceId, expoToken: opts.token } },
  });
  if (!existing || existing.userId !== opts.userId) throw new NotFoundError("Device not registered.");
  const data: Prisma.PushDeviceUpdateInput = {};
  if (typeof opts.enabled === "boolean") data.enabled = opts.enabled;
  if (opts.mutedKinds !== undefined) data.mutedKinds = cleanMuted(opts.mutedKinds);
  const row = await db.pushDevice.update({ where: { id: existing.id, workspaceId: opts.workspaceId }, data });
  return toDeviceView(row);
}

/** Forget the caller's device (sign-out). Idempotent. */
export async function removeDevice(
  db: Db,
  opts: { workspaceId: string; userId: string; token: string },
): Promise<number> {
  const res = await db.pushDevice.deleteMany({
    where: { workspaceId: opts.workspaceId, userId: opts.userId, expoToken: opts.token },
  });
  return res.count;
}
