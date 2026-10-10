// ShapesOS — Phase 21A (WS=agentweb): per-task browsing state.
//
// One entry per task (a chat thread, else a run): its safety kernel (origins,
// taint ledger) and, once a page has been opened, its browser session. The
// session outlives a single tool call, because "click e12" only means
// something on the page that snapshot described. State is in-process; an idle
// task is closed after IDLE_MS, and at most MAX_TASKS stay open (the oldest idle
// one is closed to make room).
//
// The kernel exists as soon as a task reads untrusted data (a search result, a
// page), even before any browser opens: that is what lets a first navigation
// to a search-result address ask first.

import { capabilitiesFor, type TaskCapabilities } from "./capabilities";
import { SafetyKernel } from "./kernel";
import type { BrowserSession, ProviderId } from "./provider";
import type { ElementInfo, PageContext } from "./types";

export const IDLE_MS = 5 * 60_000;
export const MAX_TASKS = 4;
export const MAX_STEPS_PER_TASK = 60;

export interface WebTask {
  key: string;
  workspaceId: string;
  kernel: SafetyKernel;
  /** False until the first navigation fixes the task's origin. */
  scoped: boolean;
  session: BrowserSession | null;
  provider: ProviderId | null;
  lastControls: ElementInfo[];
  lastPage: PageContext | null;
  steps: number;
  createdAt: number;
  lastUsed: number;
  /** Origins already probed for declared channels in this task. */
  probed: Set<string>;
}

export function taskKeyOf(ctx: { threadId?: string; runId?: string; workspaceId: string; userId: string }): string {
  return ctx.threadId ? `t:${ctx.threadId}` : ctx.runId ? `r:${ctx.runId}` : `u:${ctx.workspaceId}:${ctx.userId}`;
}

export class TaskRegistry {
  private tasks = new Map<string, WebTask>();

  constructor(private readonly opts: { idleMs?: number; max?: number; now?: () => number } = {}) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  get(key: string): WebTask | undefined {
    const t = this.tasks.get(key);
    if (t) t.lastUsed = this.now();
    return t;
  }

  /** The task's state, created (unscoped, no browser) when it has none yet. */
  async ensure(key: string, workspaceId: string, secrets: readonly string[] = []): Promise<WebTask> {
    const have = this.get(key);
    if (have) return have;
    await this.makeRoom();
    const caps: TaskCapabilities = capabilitiesFor("");
    const t: WebTask = {
      key,
      workspaceId,
      kernel: new SafetyKernel({ caps, secrets }),
      scoped: false,
      session: null,
      provider: null,
      lastControls: [],
      lastPage: null,
      steps: 0,
      createdAt: this.now(),
      lastUsed: this.now(),
      probed: new Set(),
    };
    this.tasks.set(key, t);
    return t;
  }

  async close(key: string): Promise<void> {
    const t = this.tasks.get(key);
    this.tasks.delete(key);
    await t?.session?.close().catch(() => undefined);
  }

  /** Close tasks idle for longer than the limit. */
  async reap(): Promise<number> {
    const idle = this.opts.idleMs ?? IDLE_MS;
    const stale = [...this.tasks.values()].filter((t) => this.now() - t.lastUsed > idle);
    for (const t of stale) await this.close(t.key);
    return stale.length;
  }

  private async makeRoom(): Promise<void> {
    await this.reap();
    const max = this.opts.max ?? MAX_TASKS;
    while (this.tasks.size >= max) {
      const oldest = [...this.tasks.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0]!;
      await this.close(oldest.key);
    }
  }

  async closeAll(): Promise<void> {
    for (const k of [...this.tasks.keys()]) await this.close(k);
  }

  size(): number {
    return this.tasks.size;
  }
}

/** The process-wide registry the tools use. */
export const webTasks = new TaskRegistry();
