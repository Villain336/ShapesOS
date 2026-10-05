// Marketr — Wave 2 context.dev slice 4: change-monitor engine.
//
// A Monitor watches a URL on a cadence. runDueMonitors() (invoked by
// POST /api/cron/contextdev-monitors — this module owns no timer loop):
//   1. Finds active monitors whose cadence has elapsed since lastCheckedAt.
//   2. Budget-gates the scrape BEFORE the vendor is hit (1 credit/page).
//   3. Scrapes the URL to markdown, hashes it, compares to lastSeenHash.
//      Identical hash → "unchanged", deduped silently (no change row).
//      New hash → MonitorChange row with a line diff digest + excerpt.
//   4. Optionally spawns a ResearchTask per change (opt-in per monitor,
//      itself budget-gated inside runResearch).
//   5. Scrape failures increment consecutiveFailures; 5 in a row auto-pauses
//      the monitor (a dead watch that keeps billing is worse than a paused one).
//
// Pure helpers (isDue, diffContent, contentHash) are unit-tested. Errors
// never carry the API key.

import { prisma } from "@/lib/prisma";
import { createContextDevClient, ContextDevError } from "./client";
import { contextDevCreditsFor } from "./costs";
import { checkAndReserve } from "./budget-store";
import { resolveContextDevKey } from "./keys";
import { contentHash } from "./crawl";
import { runResearch, ResearchError } from "./research";
import { extractDomain } from "./sources";

export class MonitorError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MonitorError";
    this.code = code;
  }
}

export type MonitorCadence = "hourly" | "daily" | "weekly";
export type MonitorStatus = "active" | "paused" | "archived";

export const MONITOR_CADENCES: readonly MonitorCadence[] = ["hourly", "daily", "weekly"];
export const CADENCE_INTERVAL_MS: Record<MonitorCadence, number> = {
  hourly: 3_600_000,
  daily: 86_400_000,
  weekly: 604_800_000,
};
export const MAX_CONSECUTIVE_FAILURES = 5;
export const MAX_EXCERPT_LINES = 8;

/** Pure: is this monitor due for a run at `now`? */
export function isDue(
  lastCheckedAt: Date | null,
  cadence: MonitorCadence,
  now: Date = new Date(),
): boolean {
  if (!lastCheckedAt) return true;
  return now.getTime() - lastCheckedAt.getTime() >= CADENCE_INTERVAL_MS[cadence];
}

export interface ContentDiff {
  added: number;
  removed: number;
  addedLines: string[];
  removedLines: string[];
  digest: string;
  excerpt: string;
}

/**
 * Line-set diff between two markdown snapshots. Deterministic; pure.
 * Not a unified diff — a digest: counts + the first changed lines.
 */
export function diffContent(oldText: string, newText: string): ContentDiff {
  const oldLines = oldText.split("\n").map((l) => l.trim()).filter(Boolean);
  const newLines = newText.split("\n").map((l) => l.trim()).filter(Boolean);
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const addedLines = newLines.filter((l) => !oldSet.has(l));
  const removedLines = oldLines.filter((l) => !newSet.has(l));
  const added = addedLines.length;
  const removed = removedLines.length;
  const parts: string[] = [];
  if (added) parts.push(`${added} line${added === 1 ? "" : "s"} added`);
  if (removed) parts.push(`${removed} line${removed === 1 ? "" : "s"} removed`);
  const digest = parts.length ? parts.join(", ") : "content changed";
  const excerptLines = [
    ...addedLines.slice(0, MAX_EXCERPT_LINES).map((l) => `+ ${l}`),
    ...removedLines.slice(0, MAX_EXCERPT_LINES).map((l) => `- ${l}`),
  ].slice(0, MAX_EXCERPT_LINES);
  return {
    added,
    removed,
    addedLines,
    removedLines,
    digest,
    excerpt: excerptLines.join("\n"),
  };
}

export interface RegisterMonitorInput {
  name: string;
  url: string;
  cadence?: MonitorCadence;
  sourceId?: string;
  autoResearch?: boolean;
}

export async function registerMonitor(workspaceId: string, input: RegisterMonitorInput) {
  const name = input.name.trim();
  if (!name) throw new MonitorError("BAD_NAME", "Monitor name is required");
  extractDomain(input.url); // validates the URL, fail closed
  const cadence = input.cadence ?? "daily";
  if (!MONITOR_CADENCES.includes(cadence)) {
    throw new MonitorError("BAD_CADENCE", `Cadence must be one of: ${MONITOR_CADENCES.join(", ")}`);
  }
  if (input.sourceId) {
    const source = await prisma.knowledgeSource.findFirst({
      where: { id: input.sourceId, workspaceId },
    });
    if (!source) throw new MonitorError("BAD_SOURCE", "Linked knowledge source not found");
  }
  return prisma.monitor.create({
    data: {
      workspaceId,
      name,
      url: input.url.trim(),
      cadence,
      sourceId: input.sourceId,
      autoResearch: input.autoResearch ?? false,
    },
  });
}

export async function setMonitorStatus(workspaceId: string, monitorId: string, status: MonitorStatus) {
  const monitor = await prisma.monitor.findFirst({ where: { id: monitorId, workspaceId } });
  if (!monitor) throw new MonitorError("NOT_FOUND", "Monitor not found");
  return prisma.monitor.update({
    where: { id: monitorId },
    data: { status, consecutiveFailures: status === "active" ? 0 : monitor.consecutiveFailures },
  });
}

export async function listMonitors(workspaceId: string) {
  return prisma.monitor.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { changes: true } } },
  });
}

export async function listMonitorChanges(workspaceId: string, monitorId: string, limit = 50) {
  const monitor = await prisma.monitor.findFirst({ where: { id: monitorId, workspaceId } });
  if (!monitor) throw new MonitorError("NOT_FOUND", "Monitor not found");
  return prisma.monitorChange.findMany({
    where: { monitorId },
    orderBy: { detectedAt: "desc" },
    take: limit,
  });
}

export type MonitorRunOutcome =
  | "baselined"
  | "unchanged"
  | "changed"
  | "failed"
  | "skipped_budget"
  | "skipped_key";

export interface MonitorRunResult {
  monitorId: string;
  outcome: MonitorRunOutcome;
  changeId?: string;
  researchTaskId?: string;
  error?: string;
}

/** Run one monitor check end-to-end. Exported for the manual-run API. */
export async function runMonitorCheck(
  workspaceId: string,
  monitorId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MonitorRunResult> {
  const monitor = await prisma.monitor.findFirst({ where: { id: monitorId, workspaceId } });
  if (!monitor) throw new MonitorError("NOT_FOUND", "Monitor not found");
  if (monitor.status !== "active") {
    return { monitorId, outcome: "failed", error: `Monitor is ${monitor.status}` };
  }

  // Budget gate BEFORE the vendor.
  const gate = await checkAndReserve(workspaceId, contextDevCreditsFor("scrape_markdown"));
  if (gate.decision !== "allow") {
    return { monitorId, outcome: "skipped_budget", error: gate.reason };
  }

  let apiKey: string;
  try {
    ({ apiKey } = await resolveContextDevKey(workspaceId));
  } catch (err) {
    return {
      monitorId,
      outcome: "skipped_key",
      error: err instanceof Error ? err.message : "No Context.dev key",
    };
  }

  const now = new Date();
  const markFailed = async (message: string): Promise<MonitorRunResult> => {
    const failures = monitor.consecutiveFailures + 1;
    await prisma.monitor.update({
      where: { id: monitorId },
      data: {
        consecutiveFailures: failures,
        lastCheckedAt: now,
        // A dead watch that keeps billing is worse than a paused one.
        ...(failures >= MAX_CONSECUTIVE_FAILURES ? { status: "paused" } : {}),
      },
    });
    return { monitorId, outcome: "failed", error: message };
  };

  let markdown: string;
  try {
    const client = createContextDevClient({ apiKey }, fetchImpl);
    markdown = (await client.scrapeMarkdown(monitor.url)).markdown;
  } catch (err) {
    const message =
      err instanceof ContextDevError
        ? `Context.dev ${err.code}`
        : err instanceof Error
          ? err.message
          : "Scrape failed";
    return markFailed(message);
  }

  const hash = contentHash(markdown);

  // First run: baseline, no change row.
  if (!monitor.lastSeenHash) {
    await prisma.monitor.update({
      where: { id: monitorId },
      data: {
        lastSeenHash: hash,
        lastContent: markdown.slice(0, 200_000),
        lastCheckedAt: now,
        consecutiveFailures: 0,
      },
    });
    return { monitorId, outcome: "baselined" };
  }

  // Dedup: identical hash → no change row.
  if (hash === monitor.lastSeenHash) {
    await prisma.monitor.update({
      where: { id: monitorId },
      data: { lastCheckedAt: now, consecutiveFailures: 0 },
    });
    return { monitorId, outcome: "unchanged" };
  }

  const diff = diffContent(monitor.lastContent ?? "", markdown);
  let researchTaskId: string | undefined;
  if (monitor.autoResearch) {
    try {
      const task = await runResearch(
        workspaceId,
        {
          question: `What changed on ${monitor.url}?`,
          jsonFormat: { summary: "", key_changes: [] },
          mode: "fast",
        },
        fetchImpl,
      );
      researchTaskId = task.id;
    } catch (err) {
      // Research spawn is best-effort: the change itself is still recorded.
      if (!(err instanceof ResearchError)) throw err;
    }
  }

  const change = await prisma.monitorChange.create({
    data: {
      workspaceId,
      monitorId,
      prevHash: monitor.lastSeenHash,
      newHash: hash,
      digest: diff.digest,
      excerpt: diff.excerpt || null,
      researchTaskId,
    },
  });
  await prisma.monitor.update({
    where: { id: monitorId },
    data: {
      lastSeenHash: hash,
      lastContent: markdown.slice(0, 200_000),
      lastCheckedAt: now,
      lastChangeAt: now,
      consecutiveFailures: 0,
    },
  });
  return { monitorId, outcome: "changed", changeId: change.id, researchTaskId };
}

/**
 * Cron entry point: run every active monitor whose cadence has elapsed.
 * Owns no timer loop — POST /api/cron/contextdev-monitors calls it (every 15
 * minutes from the in-app cron runner, lib/cron/jobs.ts). `workspaceId`
 * limits the sweep to one workspace (a signed-in "run now").
 */
export async function runDueMonitors(
  opts: { now?: Date; fetchImpl?: typeof fetch; limit?: number; workspaceId?: string } = {},
): Promise<MonitorRunResult[]> {
  const now = opts.now ?? new Date();
  const limit = Math.min(Math.max(1, opts.limit ?? 100), 500);
  const candidates = await prisma.monitor.findMany({
    where: { status: "active", ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}) },
    orderBy: { lastCheckedAt: "asc" },
    take: limit,
  });
  const due = candidates.filter((m) =>
    isDue(m.lastCheckedAt, m.cadence as MonitorCadence, now),
  );
  const results: MonitorRunResult[] = [];
  for (const m of due) {
    try {
      results.push(await runMonitorCheck(m.workspaceId, m.id, opts.fetchImpl ?? fetch));
    } catch (err) {
      results.push({
        monitorId: m.id,
        outcome: "failed",
        error: err instanceof Error ? err.message : "Monitor run failed",
      });
    }
  }
  return results;
}
