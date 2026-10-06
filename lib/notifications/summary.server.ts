// ShapesOS — Phase 18.3 (WS=trust): the agent-written notification summary.
//
// Opt-in (UserPreference.notifications.summary). Each morning (the briefing's
// hour) the LEAD agent writes each opted-in member a short "what happened"
// from their last 24 hours of notifications in a workspace — on the batch /
// background workload, metered, exactly like the 18.1 Today briefing (the
// same writers: lib/desktop/briefing.server.ts defaultGenerate / shouldBatch
// / defaultSubmitBatch, and the same desktop_briefings table and batch
// purpose, keyed by the day "notif-summary:<YYYY-MM-DD>"). Never on page load:
// pages only READ it. Shown as "Written by your lead agent". No live model →
// the row is marked failed with a plain reason; nothing is invented.

import { prisma } from "@/lib/prisma";
import { withUserScope } from "@/lib/desktop/scope";
import { batchKeyFor, cleanBriefingText, isBriefingDue, localDay } from "@/lib/desktop/briefing";
import { defaultGenerate, defaultSubmitBatch, shouldBatch, type BriefingDeps } from "@/lib/desktop/briefing.server";

export const NO_MODEL_REASON = "No live AI model is connected, so your lead agent could not write today's summary. Connect a model in Settings → AI models.";
import { DEFAULT_TIME_ZONE, resolveTimeZone } from "@/lib/time/zoned";
import { coercePreferences } from "@/lib/preferences";
import { SUMMARY_DAY_PREFIX, buildSummaryPrompt, type SummaryInput } from "./digest";

export function summaryDay(now: Date, timeZone: string | null | undefined): string {
  return `${SUMMARY_DAY_PREFIX}${localDay(now, timeZone)}`;
}

export interface SummaryDeps extends Pick<BriefingDeps, "generate" | "batch" | "submitBatch"> {
  gather?: (workspaceId: string, userId: string, now: Date) => Promise<SummaryInput>;
}

export async function gatherSummaryInput(workspaceId: string, userId: string, now: Date, timeZone: string): Promise<SummaryInput> {
  const [rows, ws, member, prefs] = await Promise.all([
    prisma.notification.findMany({
      where: { workspaceId, userId, createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60_000) } },
      orderBy: { createdAt: "desc" },
      take: 60,
      select: { kind: true, title: true, body: true, readAt: true },
    }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } }),
    prisma.workspaceMember.findFirst({ where: { workspaceId, userId }, select: { name: true } }),
    prisma.userPreference.findUnique({ where: { userId } }),
  ]);
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
  return {
    memberName: member?.name ?? null,
    workspaceName: ws?.name ?? "Workspace",
    day: localDay(now, timeZone),
    language: prefs?.language ?? null,
    counts,
    items: rows.slice(0, 25).map((r) => `${r.readAt ? "" : "(unread) "}${r.title}${r.body ? ` — ${r.body.replace(/\s+/g, " ").slice(0, 120)}` : ""}`),
  };
}

export type SummaryOutcome = { status: "exists" | "ready" | "submitted" | "empty" } | { status: "failed"; error: string };

/** Write today's summary for one member in one workspace, once. */
export async function ensureNotificationSummary(
  workspaceId: string,
  userId: string,
  opts: { now?: Date; timeZone?: string | null; deps?: SummaryDeps } = {},
): Promise<SummaryOutcome> {
  const now = opts.now ?? new Date();
  const tz = resolveTimeZone(opts.timeZone ?? DEFAULT_TIME_ZONE);
  const day = summaryDay(now, tz);
  const deps = opts.deps ?? {};
  const input = await (deps.gather ?? ((w, u, n) => gatherSummaryInput(w, u, n, tz)))(workspaceId, userId, now);
  if (Object.keys(input.counts).length === 0) return { status: "empty" };
  const claimed = await withUserScope(workspaceId, userId, async (tx) => {
    const res = await tx.desktopBriefing.createMany({ data: [{ workspaceId, userId, day, status: "pending" }], skipDuplicates: true });
    return res.count === 1;
  });
  if (!claimed) return { status: "exists" };
  const finish = (data: { status: "ready" | "failed"; body?: string | null; error?: string | null; model?: string | null; sources?: object }) =>
    withUserScope(workspaceId, userId, (tx) =>
      tx.desktopBriefing.update({
        where: { workspaceId_userId_day: { workspaceId, userId, day } },
        data: { ...data, ...(data.status === "ready" ? { readyAt: new Date() } : {}) },
      }),
    );
  const prompt = buildSummaryPrompt(input);
  const sources = { notifications: Object.values(input.counts).reduce((a, b) => a + b, 0) };
  try {
    if (await shouldBatch(workspaceId, deps)) {
      const key = batchKeyFor(day, userId);
      await (deps.submitBatch ?? defaultSubmitBatch)({ workspaceId, key, prompt, userId, day });
      await withUserScope(workspaceId, userId, (tx) =>
        tx.desktopBriefing.update({ where: { workspaceId_userId_day: { workspaceId, userId, day } }, data: { batchKey: key, sources } }),
      );
      return { status: "submitted" };
    }
    const out = await (deps.generate ?? defaultGenerate)(workspaceId, userId, prompt);
    if (!out.live) {
      await finish({ status: "failed", error: NO_MODEL_REASON, model: out.model, sources });
      return { status: "failed", error: NO_MODEL_REASON };
    }
    const body = cleanBriefingText(out.text);
    if (!body) {
      await finish({ status: "failed", error: "The model returned an empty summary.", model: out.model, sources });
      return { status: "failed", error: "empty" };
    }
    await finish({ status: "ready", body, model: out.model, sources });
    return { status: "ready" };
  } catch (err) {
    const error = err instanceof Error ? err.message.slice(0, 300) : "The summary could not be written.";
    await finish({ status: "failed", error, sources });
    return { status: "failed", error };
  }
}

export interface SummaryView {
  status: "none" | "pending" | "ready" | "failed";
  body: string | null;
  error: string | null;
  writtenAt: string | null;
}

/** What the notifications page shows — a read, never a generation. */
export async function readNotificationSummary(workspaceId: string, userId: string, timeZone: string | null, now: Date = new Date()): Promise<SummaryView> {
  const day = summaryDay(now, timeZone);
  const row = await withUserScope(workspaceId, userId, (tx) =>
    tx.desktopBriefing.findUnique({ where: { workspaceId_userId_day: { workspaceId, userId, day } }, select: { status: true, body: true, error: true, readyAt: true } }),
  );
  if (!row) return { status: "none", body: null, error: null, writtenAt: null };
  return {
    status: row.status === "ready" ? "ready" : row.status === "failed" ? "failed" : "pending",
    body: row.status === "ready" ? row.body : null,
    error: row.status === "failed" ? row.error : null,
    writtenAt: row.readyAt ? row.readyAt.toISOString() : null,
  };
}

/** Today's ready summary text across a person's workspaces (for the email digest). */
export async function summaryTextFor(userId: string, timeZone: string, now: Date): Promise<string | null> {
  const memberships = await prisma.workspaceMember.findMany({ where: { userId }, select: { workspaceId: true }, take: 20 });
  const parts: string[] = [];
  for (const m of memberships) {
    const s = await readNotificationSummary(m.workspaceId, userId, timeZone, now).catch(() => null);
    if (s?.status === "ready" && s.body) parts.push(s.body);
  }
  return parts.length ? parts.join("\n\n") : null;
}

export interface SummarySweepResult {
  people: number;
  written: number;
  submitted: number;
  failed: number;
  skipped: number;
}

/** Every opted-in member whose morning has come, once per workspace per day (bounded). */
export async function runSummarySweep(opts: { now?: Date; maxPeople?: number; deps?: SummaryDeps } = {}): Promise<SummarySweepResult> {
  const now = opts.now ?? new Date();
  const out: SummarySweepResult = { people: 0, written: 0, submitted: 0, failed: 0, skipped: 0 };
  const rows = await prisma.userPreference.findMany({ where: { notifications: { path: ["summary"], equals: true } }, take: opts.maxPeople ?? 300 });
  for (const row of rows) {
    out.people++;
    const prefs = coercePreferences({ timeZone: row.timeZone, notifications: row.notifications });
    if (!prefs.notifications.summary) continue;
    const tz = prefs.timeZone ?? DEFAULT_TIME_ZONE;
    if (!isBriefingDue(now, tz)) {
      out.skipped++;
      continue;
    }
    const memberships = await prisma.workspaceMember.findMany({ where: { userId: row.userId }, select: { workspaceId: true }, take: 20 });
    for (const m of memberships) {
      const r = await ensureNotificationSummary(m.workspaceId, row.userId, { now, timeZone: tz, deps: opts.deps }).catch(
        (err): SummaryOutcome => ({ status: "failed", error: err instanceof Error ? err.message : "error" }),
      );
      if (r.status === "ready") out.written++;
      else if (r.status === "submitted") out.submitted++;
      else if (r.status === "failed") out.failed++;
      else out.skipped++;
    }
  }
  return out;
}
