// ShapesOS — Phase 18.1 (WS=desk): the "Today" briefing, server half.
//
//   ensureTodayBriefing(ws, user)   writes today's row ONCE (unique per
//                                   member per local day) and has the lead
//                                   agent write it: through the Message
//                                   Batches path when the workspace's
//                                   background model supports it (50% off;
//                                   lib/llm/batch.ts, purpose
//                                   "desktop_briefing"), else one direct
//                                   background-workload call. Both are metered
//                                   to the workspace (cap checked first).
//   readTodayBriefing(ws, user)     what the widget shows — a read, never a
//                                   generation (Home never writes on load).
//   runBriefingSweep()              /api/cron/desk: every opted-in member
//                                   whose morning has come and has no row yet.
//
// No live model (mock): the row is marked failed with a plain reason and
// nothing is invented — a mock answer must never read as the agent's words.

import { prisma } from "@/lib/prisma";
import { withUserScope } from "./scope";
import {
  BRIEFING_BATCH_PURPOSE,
  BRIEFING_MAX_TOKENS,
  batchKeyFor,
  briefingSources,
  buildBriefingPrompt,
  cleanBriefingText,
  isBriefingDue,
  localDay,
  type BriefingInput,
} from "./briefing";
import type { BriefingData, LoaderContext } from "./loaders.server";
import { DEFAULT_TIME_ZONE, resolveTimeZone } from "@/lib/time/zoned";

export interface BriefingDeps {
  /** Direct generation (default: the workspace's background workload, metered). */
  generate?: (workspaceId: string, userId: string, prompt: string) => Promise<{ text: string; model: string; live: boolean }>;
  /** Force the batch path on/off (default: decided like the learning pass). */
  batch?: boolean;
  /** Gather (default: the real sources). */
  gather?: (workspaceId: string, userId: string, now: Date, timeZone: string) => Promise<BriefingInput>;
  /** Submit to the batch path (default: lib/llm/batch submitLlmBatch). */
  submitBatch?: (input: { workspaceId: string; key: string; prompt: string; userId: string; day: string }) => Promise<void>;
}

export const NO_MODEL_REASON = "No live AI model is connected, so your lead agent could not write today's briefing. Connect a model in Settings → AI models.";

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function readTodayBriefing(workspaceId: string, userId: string, timeZone: string | null, now: Date = new Date()): Promise<BriefingData> {
  const day = localDay(now, timeZone);
  const [desk, row] = await withUserScope(workspaceId, userId, (tx) =>
    Promise.all([
      tx.userDesktopLayout.findUnique({ where: { workspaceId_userId: { workspaceId, userId } }, select: { briefingEnabled: true } }),
      tx.desktopBriefing.findUnique({
        where: { workspaceId_userId_day: { workspaceId, userId, day } },
        select: { status: true, body: true, error: true, readyAt: true, model: true },
      }),
    ]),
  );
  const enabled = desk?.briefingEnabled ?? false;
  if (!row) return { enabled, day, status: enabled ? "none" : "off", body: null, error: null, writtenAt: null, model: null };
  return {
    enabled,
    day,
    status: row.status === "ready" ? "ready" : row.status === "failed" ? "failed" : "pending",
    body: row.status === "ready" ? row.body : null,
    error: row.status === "failed" ? row.error : null,
    writtenAt: row.readyAt ? row.readyAt.toISOString() : null,
    model: row.model,
  };
}

// ---------------------------------------------------------------------------
// Gathering the facts
// ---------------------------------------------------------------------------

function fmtTime(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
}

function runLabel(r: { kind: string; agentKey: string | null; agentState: unknown }): string {
  const st = r.agentState && typeof r.agentState === "object" ? (r.agentState as Record<string, unknown>) : {};
  const what = typeof st.prompt === "string" && st.prompt.trim() ? st.prompt.trim().replace(/\s+/g, " ").slice(0, 80) : typeof st.task === "string" ? st.task.slice(0, 80) : r.kind;
  return `${r.agentKey ?? r.kind}: ${what}`;
}

export async function gatherBriefingInput(workspaceId: string, userId: string, now: Date, timeZone: string): Promise<BriefingInput> {
  const tz = resolveTimeZone(timeZone);
  const [ws, member, language] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } }),
    prisma.workspaceMember.findFirst({ where: { workspaceId, userId }, select: { name: true, role: true } }),
    // Phase 18.1 (integration): written in the member's language preference (English when unset).
    import("@/lib/preferences")
      .then((m) => m.getUserPreferences(userId))
      .then((p) => p.language)
      .catch(() => null),
  ]);
  const role = member?.role ?? "viewer";
  const ctx: LoaderContext = { workspaceId, userId, role, now, timeZone: tz, workspaceName: ws?.name ?? "Workspace" };
  const { WIDGET_LOADERS } = await import("./loaders.server");
  const settle = <T,>(p: Promise<T>) => p.then((v) => v, () => null);
  const since = new Date(now.getTime() - 14 * 3600 * 1000);
  const { withWorkspaceScope } = await import("@/lib/substrate/memory/rls");
  const [calendar, needs, pipeline, cash, inbox, runs] = await Promise.all([
    settle(WIDGET_LOADERS.calendar(ctx)),
    settle(WIDGET_LOADERS["needs-you"](ctx)),
    settle(WIDGET_LOADERS.pipeline(ctx)),
    settle(WIDGET_LOADERS.cash(ctx)),
    settle(WIDGET_LOADERS.inbox(ctx)),
    settle(
      withWorkspaceScope(workspaceId, (tx) =>
        tx.agentRun.findMany({
          where: { workspaceId, parentRunId: null, OR: [{ endedAt: { gte: since } }, { status: { in: ["queued", "running", "awaiting_confirmation"] } }] },
          orderBy: { createdAt: "desc" },
          take: 60,
          select: { kind: true, status: true, agentKey: true, agentState: true },
        }),
      ),
    ),
  ]);
  const runRows = runs ?? [];
  const failed = runRows.filter((r) => r.status === "failed");
  const finished = runRows.filter((r) => r.status === "succeeded");
  const metrics: BriefingInput["metrics"] = [];
  if (pipeline && pipeline.openCount > 0) metrics.push({ label: "Open pipeline", value: `${pipeline.openCount} leads, ${money(pipeline.openValueCents)}` });
  if (cash) {
    metrics.push({ label: "Payments, last 30 days", value: money(cash.paymentsLast30dCents) });
    if (cash.overdueInvoices > 0) metrics.push({ label: "Overdue invoices", value: String(cash.overdueInvoices) });
  }
  if (inbox && inbox.unreadThreads > 0) metrics.push({ label: "Unread conversations", value: String(inbox.unreadThreads) });
  return {
    language,
    memberName: member?.name ?? null,
    workspaceName: ctx.workspaceName,
    day: localDay(now, tz),
    timeZone: tz,
    calendar: (calendar?.items ?? []).filter((i) => !i.mock).slice(0, 10).map((i) => ({ time: fmtTime(i.start, tz), title: i.title })),
    calendarConnected: !!calendar && (calendar.connected.google || calendar.connected.outlook),
    needsYou: { count: needs?.actionable ?? 0, items: (needs?.items ?? []).filter((i) => i.canDecide).slice(0, 5).map((i) => `${i.title} (${i.source})`) },
    overnight: {
      finished: finished.length,
      failed: failed.length,
      waiting: runRows.filter((r) => r.status === "awaiting_confirmation").length,
      running: runRows.filter((r) => r.status === "running" || r.status === "queued").length,
      highlights: [...failed.slice(0, 3).map((r) => `Failed — ${runLabel(r)}`), ...finished.slice(0, 2).map((r) => `Finished — ${runLabel(r)}`)],
    },
    metrics,
  };
}

// ---------------------------------------------------------------------------
// Writing (once per member per day)
// ---------------------------------------------------------------------------

async function defaultGenerate(workspaceId: string, userId: string, prompt: string) {
  const { getLlmProviderForWorkspace } = await import("@/lib/llm/workspace");
  const provider = await getLlmProviderForWorkspace("background", { workspaceId, actorId: userId });
  if (!provider.isLive) return { text: "", model: provider.name, live: false };
  const text = await provider.generate(prompt, { maxTokens: BRIEFING_MAX_TOKENS });
  return { text, model: provider.name, live: true };
}

async function shouldBatch(workspaceId: string, deps: BriefingDeps): Promise<boolean> {
  if (deps.batch !== undefined) return deps.batch;
  const { batchEnabled, batchProviderOf } = await import("@/lib/llm/batch");
  const { agentWorkerMode } = await import("@/lib/agents/queue/config");
  if (!batchEnabled() || agentWorkerMode() === "off") return false;
  const { resolveWorkloadForWorkspace } = await import("@/lib/llm/workspace");
  const provider = (await resolveWorkloadForWorkspace("background", workspaceId)).provider;
  return provider.isLive && batchProviderOf(provider) !== null;
}

async function defaultSubmitBatch(input: { workspaceId: string; key: string; prompt: string; userId: string; day: string }) {
  const { submitLlmBatch } = await import("@/lib/llm/batch");
  await import("@/lib/llm/batch-purposes");
  await submitLlmBatch({
    workspaceId: input.workspaceId,
    purpose: BRIEFING_BATCH_PURPOSE,
    idempotencyKey: input.key,
    workload: "background",
    requests: [{ customId: "briefing", prompt: input.prompt, maxTokens: BRIEFING_MAX_TOKENS }],
    context: { userId: input.userId, day: input.day },
  });
}

export type EnsureOutcome =
  | { status: "exists"; day: string }
  | { status: "ready"; day: string }
  | { status: "submitted"; day: string }
  | { status: "failed"; day: string; error: string };

/**
 * Write today's briefing for a member, once. A second call the same local day
 * (cron twice, a double click on "Turn on") finds the row and does nothing.
 */
export async function ensureTodayBriefing(
  workspaceId: string,
  userId: string,
  opts: { now?: Date; timeZone?: string | null; deps?: BriefingDeps } = {},
): Promise<EnsureOutcome> {
  const now = opts.now ?? new Date();
  const tz = resolveTimeZone(opts.timeZone ?? DEFAULT_TIME_ZONE);
  const day = localDay(now, tz);
  const deps = opts.deps ?? {};
  // Claim the day: the unique (workspace, user, day) row is the lock.
  const claimed = await withUserScope(workspaceId, userId, async (tx) => {
    const res = await tx.desktopBriefing.createMany({ data: [{ workspaceId, userId, day, status: "pending" }], skipDuplicates: true });
    return res.count === 1;
  });
  if (!claimed) return { status: "exists", day };

  const finish = (data: { status: "ready" | "failed"; body?: string | null; error?: string | null; model?: string | null; sources?: object; batchKey?: string | null }) =>
    withUserScope(workspaceId, userId, (tx) =>
      tx.desktopBriefing.update({
        where: { workspaceId_userId_day: { workspaceId, userId, day } },
        data: { ...data, ...(data.status === "ready" ? { readyAt: new Date() } : {}) },
      }),
    );

  let input: BriefingInput;
  try {
    input = await (deps.gather ?? gatherBriefingInput)(workspaceId, userId, now, tz);
  } catch (err) {
    const error = `Could not gather today's facts (${err instanceof Error ? err.message.slice(0, 160) : "error"}).`;
    await finish({ status: "failed", error });
    return { status: "failed", day, error };
  }
  const prompt = buildBriefingPrompt(input);
  const sources = briefingSources(input);
  try {
    if (await shouldBatch(workspaceId, deps)) {
      const key = batchKeyFor(day, userId);
      await (deps.submitBatch ?? defaultSubmitBatch)({ workspaceId, key, prompt, userId, day });
      await withUserScope(workspaceId, userId, (tx) =>
        tx.desktopBriefing.update({ where: { workspaceId_userId_day: { workspaceId, userId, day } }, data: { batchKey: key, sources } }),
      );
      return { status: "submitted", day };
    }
    const out = await (deps.generate ?? defaultGenerate)(workspaceId, userId, prompt);
    if (!out.live) {
      await finish({ status: "failed", error: NO_MODEL_REASON, model: out.model, sources });
      return { status: "failed", day, error: NO_MODEL_REASON };
    }
    const body = cleanBriefingText(out.text);
    if (!body) {
      await finish({ status: "failed", error: "The model returned an empty briefing.", model: out.model, sources });
      return { status: "failed", day, error: "empty" };
    }
    await finish({ status: "ready", body, model: out.model, sources });
    return { status: "ready", day };
  } catch (err) {
    const error = err instanceof Error ? err.message.slice(0, 300) : "The briefing could not be written.";
    await finish({ status: "failed", error, sources });
    return { status: "failed", day, error };
  }
}

/** The batch delivery: write the text into the member's row (idempotent: only a pending row changes). */
export async function deliverBriefingResult(
  workspaceId: string,
  context: Record<string, unknown> | null,
  result: { text: string } | { error: string } | undefined,
  model: string | null,
): Promise<void> {
  const userId = typeof context?.userId === "string" ? context.userId : null;
  const day = typeof context?.day === "string" ? context.day : null;
  if (!userId || !day) return;
  const ok = result && "text" in result ? cleanBriefingText(result.text) : "";
  await withUserScope(workspaceId, userId, (tx) =>
    tx.desktopBriefing.updateMany({
      where: { workspaceId, userId, day, status: "pending" },
      data: ok
        ? { status: "ready", body: ok, model: model ?? "batch", readyAt: new Date() }
        : { status: "failed", error: result && "error" in result ? result.error.slice(0, 300) : "The batch returned no briefing." },
    }),
  );
}

// ---------------------------------------------------------------------------
// The opt-in and the morning sweep
// ---------------------------------------------------------------------------

/** Turn the briefing on/off; turning it on writes today's (once) right away. */
export async function setBriefingOptIn(
  workspaceId: string,
  userId: string,
  enabled: boolean,
  opts: { timeZone?: string | null; deps?: BriefingDeps } = {},
): Promise<EnsureOutcome | null> {
  const { setBriefingEnabled } = await import("./store.server");
  await setBriefingEnabled(workspaceId, userId, enabled);
  if (!enabled) return null;
  return ensureTodayBriefing(workspaceId, userId, { timeZone: opts.timeZone, deps: opts.deps });
}

export interface SweepReport {
  workspaces: number;
  members: number;
  written: number;
  submitted: number;
  failed: number;
  skipped: number;
}

/**
 * Every opted-in member whose local morning has come and who has no briefing
 * for today yet. Rows are owner-only (RLS), so each member's opt-in is read
 * inside their own scope. Bounded per run.
 */
export async function runBriefingSweep(
  opts: { now?: Date; maxWorkspaces?: number; maxMembers?: number; workspaceId?: string | null; timeZoneOf?: (userId: string) => Promise<string | null>; deps?: BriefingDeps } = {},
): Promise<SweepReport> {
  const now = opts.now ?? new Date();
  const report: SweepReport = { workspaces: 0, members: 0, written: 0, submitted: 0, failed: 0, skipped: 0 };
  const workspaces = opts.workspaceId
    ? [{ id: opts.workspaceId }]
    : await prisma.workspace.findMany({ where: { frozenAt: null }, select: { id: true }, orderBy: { createdAt: "asc" }, take: opts.maxWorkspaces ?? 200 });
  let budget = opts.maxMembers ?? 500;
  // Phase 18.1 (integration): the member's "timeZone" preference
  // (lib/preferences via the desk adapter); UTC until they set one.
  const tzOf =
    opts.timeZoneOf ??
    (async (userId: string) => {
      const { getUserPreferences } = await import("./prefs");
      return (await getUserPreferences(userId).catch(() => null))?.timeZone ?? null;
    });
  for (const ws of workspaces) {
    report.workspaces++;
    const members = await prisma.workspaceMember.findMany({ where: { workspaceId: ws.id, userId: { not: null } }, select: { userId: true }, take: 500 });
    for (const m of members) {
      if (budget <= 0) return report;
      const userId = m.userId!;
      const optedIn = await withUserScope(ws.id, userId, (tx) =>
        tx.userDesktopLayout.findUnique({ where: { workspaceId_userId: { workspaceId: ws.id, userId } }, select: { briefingEnabled: true } }),
      );
      if (!optedIn?.briefingEnabled) continue;
      report.members++;
      const tz = (await tzOf(userId)) ?? DEFAULT_TIME_ZONE;
      if (!isBriefingDue(now, tz)) {
        report.skipped++;
        continue;
      }
      budget--;
      const out = await ensureTodayBriefing(ws.id, userId, { now, timeZone: tz, deps: opts.deps }).catch(
        (err): EnsureOutcome => ({ status: "failed", day: localDay(now, tz), error: err instanceof Error ? err.message : "error" }),
      );
      if (out.status === "ready") report.written++;
      else if (out.status === "submitted") report.submitted++;
      else if (out.status === "failed") report.failed++;
      else report.skipped++;
    }
  }
  return report;
}
