// Marketr — Phase 16 slice 5: Playwright run recorder.
//
// Headed-Chromium run recording producing (a) WebM video, (b) Playwright
// trace (trace.zip: DOM snapshots per step, network, console), (c) timeline
// callbacks the lifecycle layer persists as AgentRunEvent rows.
//
// SERVER-SIDE ONLY: nothing here is reachable from the client. The recorder
// never exposes raw browser control — the agent's browser work arrives as
// the `execute` callback in lifecycle.ts, not as client input. Live watch is
// slice 7, the viewer is slice 6.
//
// Pure with respect to the DB: timeline events go out through onTimelineEvent
// so unit tests never touch prisma. The browser is injectable (BrowserLauncher)
// so tests stub the launch — the box's real Chromium is only exercised by the
// explicit live proof, never by the suite.
//
// Concurrency (spec §8): browser runs are CPU-heavy on the 8GB box. An
// in-process semaphore caps concurrent recordings (default 1, override with
// MARKETR_MAX_BROWSER_RECORDINGS); start() fails fast with RecorderBusyError
// when saturated. Cross-process queuing is slice 7/8 scope.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { chromium } from "playwright";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright";
import type { AgentRunEventInput } from "./types";
import { attachWatch } from "./watch";

/** Repo-local host-owned artifact root (gitignored). */
export const ARTIFACT_ROOT = path.join(process.cwd(), ".run-artifacts");

/** Recording video size (matches the dashboard viewer surface). */
export const RECORDING_VIDEO_SIZE = { width: 1280, height: 800 } as const;

/** Decision (c): 30 days, then summarize (the slice-8 sweep drops videos). */
export const RECORDING_RETENTION_DAYS = 30;

export class RecorderBusyError extends Error {
  constructor() {
    super(
      "browser recorder saturated: another recording is running on this process; retry later",
    );
    this.name = "RecorderBusyError";
  }
}

// ---- injectable browser surface (structural; tests stub this) ----

/** Screencast capture profile handed to a page that supports CDP screencast. */
export interface ScreencastOptions {
  quality: number;
  everyNthFrame: number;
  maxWidth: number;
  maxHeight: number;
}

export type ScreencastFrameHandler = (jpeg: Buffer) => void | Promise<void>;

export interface RecorderPage {
  goto(url: string): Promise<void>;
  /**
   * Phase 8 (browser tools): the actions an agent's browser_act / extract
   * steps drive. Optional so stub launchers stay minimal; the production
   * launcher implements all of them over the Playwright page.
   */
  click?(selector: string, opts?: { timeoutMs?: number }): Promise<void>;
  fill?(selector: string, value: string, opts?: { timeoutMs?: number }): Promise<void>;
  waitFor?(target: { selector?: string; ms?: number; timeoutMs?: number }): Promise<void>;
  screenshot?(filePath: string): Promise<void>;
  /** innerText of up to `limit` elements matching the selector. */
  extract?(selector: string, opts?: { limit?: number; timeoutMs?: number }): Promise<string[]>;
  title?(): Promise<string>;
  url?(): string;
  /**
   * Slice 7: start CDP screencast on this page. Resolves with a stop
   * function; every captured frame is delivered as JPEG bytes to onFrame.
   * Absent on stub launchers and on browser builds without the CDP
   * surface — the watch layer then skips the stream instead of failing.
   */
  startScreencast?: (
    opts: ScreencastOptions,
    onFrame: ScreencastFrameHandler,
  ) => Promise<() => Promise<void>>;
}

export interface RecorderContext {
  tracingStart(opts: { screenshots: boolean; snapshots: boolean; sources: boolean }): Promise<void>;
  tracingStop(tracePath: string): Promise<void>;
  newPage(): Promise<RecorderPage>;
  close(): Promise<void>;
  /** Resolved video path; null when the browser produced no video. */
  videoPath(): Promise<string | null>;
}

/**
 * Phase 8: decides whether the browser may load a URL (every request,
 * redirect hop and subresource). The browser tools pass the SSRF guard from
 * lib/safe-url.ts; refused requests are aborted.
 */
export type RequestGuard = (url: string) => Promise<boolean>;

export interface RecorderBrowser {
  newContext(opts: {
    recordVideoDir: string;
    videoWidth: number;
    videoHeight: number;
    guardRequest?: RequestGuard;
  }): Promise<RecorderContext>;
  close(): Promise<void>;
}

export interface BrowserLauncher {
  launch(opts: { headless: boolean }): Promise<RecorderBrowser>;
}

/** Production launcher: real Chromium via the repo's playwright install. */
export const playwrightLauncher: BrowserLauncher = {
  async launch(opts: { headless: boolean }): Promise<RecorderBrowser> {
    const browser: Browser = await chromium.launch({ headless: opts.headless });
    return {
      async newContext(cOpts): Promise<RecorderContext> {
        const ctx: BrowserContext = await browser.newContext({
          viewport: { width: cOpts.videoWidth, height: cOpts.videoHeight },
          recordVideo: {
            dir: cOpts.recordVideoDir,
            size: { width: cOpts.videoWidth, height: cOpts.videoHeight },
          },
          // Phase 8: a service worker could fetch around the request guard.
          ...(cOpts.guardRequest ? { serviceWorkers: "block" as const } : {}),
        });
        const guard = cOpts.guardRequest;
        if (guard) {
          // Every request (navigation, redirect hop, subresource) is checked.
          await ctx.route("**/*", async (route) => {
            const u = route.request().url();
            if (/^(data|blob|about):/i.test(u) || (await guard(u).catch(() => false))) await route.continue();
            else await route.abort("blockedbyclient");
          });
          await ctx.routeWebSocket(/.*/, async (ws) => {
            const httpUrl = ws.url().replace(/^ws(s?):/i, "http$1:");
            if (await guard(httpUrl).catch(() => false)) ws.connectToServer();
            else await ws.close({ code: 1008, reason: "blocked" });
          });
        }
        return {
          async tracingStart(tOpts) {
            await ctx.tracing.start({
              screenshots: tOpts.screenshots,
              snapshots: tOpts.snapshots,
              sources: tOpts.sources,
            });
          },
          async tracingStop(tracePath: string) {
            await ctx.tracing.stop({ path: tracePath });
          },
          async newPage(): Promise<RecorderPage> {
            const page: Page = await ctx.newPage();
            return {
              goto: (url: string) => page.goto(url).then(() => undefined),
              click: (selector, o) => page.click(selector, { timeout: o?.timeoutMs ?? 15_000 }),
              fill: (selector, value, o) => page.fill(selector, value, { timeout: o?.timeoutMs ?? 15_000 }),
              waitFor: async (t) => {
                if (t.selector) await page.waitForSelector(t.selector, { timeout: t.timeoutMs ?? 15_000 });
                else await page.waitForTimeout(Math.min(Math.max(t.ms ?? 1000, 0), 30_000));
              },
              screenshot: (filePath) => page.screenshot({ path: filePath }).then(() => undefined),
              extract: async (selector, o) => {
                await page.waitForSelector(selector, { timeout: o?.timeoutMs ?? 10_000, state: "attached" }).catch(() => undefined);
                const all = await page.locator(selector).allInnerTexts();
                return all.slice(0, o?.limit ?? 20);
              },
              title: () => page.title(),
              url: () => page.url(),
              // Slice 7: real CDP screencast (Page.startScreencast → JPEG
              // frames). The ack loop throttles capture to consumer speed:
              // the next frame is only sent after we ack the current one.
              startScreencast: async (opts: ScreencastOptions, onFrame: ScreencastFrameHandler) => {
                const cdp: CDPSession = await ctx.newCDPSession(page);
                let stopped = false;
                const onScreencastFrame = (payload: { data: string; sessionId: number }) => {
                  if (stopped) return;
                  void (async () => {
                    try {
                      await onFrame(Buffer.from(payload.data, "base64"));
                    } finally {
                      if (!stopped) {
                        await cdp
                          .send("Page.screencastFrameAck", { sessionId: payload.sessionId })
                          .catch(() => undefined);
                      }
                    }
                  })();
                };
                cdp.on("Page.screencastFrame", onScreencastFrame);
                await cdp.send("Page.startScreencast", {
                  format: "jpeg",
                  quality: opts.quality,
                  maxWidth: opts.maxWidth,
                  maxHeight: opts.maxHeight,
                  everyNthFrame: opts.everyNthFrame,
                });
                return async () => {
                  if (stopped) return;
                  stopped = true;
                  cdp.off("Page.screencastFrame", onScreencastFrame);
                  await cdp.send("Page.stopScreencast").catch(() => undefined);
                  await cdp.detach().catch(() => undefined);
                };
              },
            };
          },
          async close() {
            await ctx.close();
          },
          async videoPath(): Promise<string | null> {
            const pages = ctx.pages();
            for (const p of pages) {
              const v = p.video();
              if (v) return v.path();
            }
            return null;
          },
        };
      },
      async close() {
        await browser.close();
      },
    };
  },
};

// ---- concurrency semaphore (in-process; default 1 on the 8GB box) ----

let activeRecordings = 0;

export function maxConcurrentRecordings(): number {
  const raw = process.env.MARKETR_MAX_BROWSER_RECORDINGS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function acquireSlot(): void {
  if (activeRecordings >= maxConcurrentRecordings()) throw new RecorderBusyError();
  activeRecordings += 1;
}

function releaseSlot(): void {
  activeRecordings = Math.max(0, activeRecordings - 1);
}

/** Test seam: read current slot usage (production code never calls this). */
export function _activeRecordingCountForTests(): number {
  return activeRecordings;
}

export interface RecorderOptions {
  runId: string;
  /** Artifact directory override; defaults to .run-artifacts/<runId>. */
  artifactDir?: string;
  /** Injected launcher (tests); production uses playwrightLauncher. */
  launcher?: BrowserLauncher;
  /** Headed (true = watchable later by slice 7; false = headless-shell). */
  headless?: boolean;
  /**
   * Slice 7: attach the live watch stream (CDP screencast → in-process
   * registry → SSE). Defaults to false — the SSE route only streams while
   * a producer is attached. Frames are transient; the WebM stays the
   * permanent record.
   */
  watch?: boolean;
  /** Timeline sink — lifecycle.ts persists these as AgentRunEvent rows. */
  onTimelineEvent?: (event: AgentRunEventInput) => void | Promise<void>;
  /** Phase 8: per-request URL guard (SSRF) handed to the browser context. */
  guardRequest?: RequestGuard;
}

export interface StoppedRecording {
  videoPath: string | null;
  tracePath: string;
  stepCount: number;
  /** Sum of video + trace bytes on disk (0 when files are absent). */
  sizeBytes: number;
  artifactDir: string;
}

/**
 * AgentRunRecorder — one Chromium context per agent browser run.
 *
 * Usage:
 *   const rec = new AgentRunRecorder({ runId, headless: false });
 *   const { page } = await rec.start("https://…");   // starts video + trace
 *   await rec.recordAction("Clicked 'Checkout'", { selector: "…" });
 *   const stopped = await rec.stop();                // video.webm + trace.zip
 *
 * start() throws RecorderBusyError when the box is saturated. stop() is
 * idempotent-ish: it always releases the slot and closes the browser.
 */
export class AgentRunRecorder {
  private readonly opts: Required<Omit<RecorderOptions, "onTimelineEvent" | "launcher" | "artifactDir" | "headless" | "watch" | "guardRequest">> &
    Pick<RecorderOptions, "onTimelineEvent" | "launcher" | "headless" | "watch" | "guardRequest"> & { artifactDir: string };
  private browser: RecorderBrowser | null = null;
  private context: RecorderContext | null = null;
  private slotHeld = false;
  private stopped = false;
  private stepCount = 0;
  private tracePath: string;
  /** Slice 7: detach handle for the live watch stream (null when not watching). */
  private watchDetach: (() => Promise<void>) | null = null;

  constructor(options: RecorderOptions) {
    if (!options.runId) throw new Error("AgentRunRecorder: runId is required");
    const artifactDir = options.artifactDir ?? path.join(ARTIFACT_ROOT, options.runId);
    this.opts = { ...options, artifactDir };
    this.tracePath = path.join(artifactDir, "trace.zip");
  }

  get artifactDir(): string {
    return this.opts.artifactDir;
  }

  /** Headed Chromium + video + trace running; resolves once tracing started. */
  async start(startUrl?: string): Promise<{ page: RecorderPage }> {
    if (this.browser) throw new Error("AgentRunRecorder: already started");
    acquireSlot();
    this.slotHeld = true;
    try {
      await fs.mkdir(this.opts.artifactDir, { recursive: true });
      const launcher = this.opts.launcher ?? playwrightLauncher;
      this.browser = await launcher.launch({ headless: this.opts.headless ?? true });
      this.context = await this.browser.newContext({
        recordVideoDir: this.opts.artifactDir,
        videoWidth: RECORDING_VIDEO_SIZE.width,
        videoHeight: RECORDING_VIDEO_SIZE.height,
        ...(this.opts.guardRequest ? { guardRequest: this.opts.guardRequest } : {}),
      });
      await this.context.tracingStart({ screenshots: true, snapshots: true, sources: true });
      const page = await this.context.newPage();
      // Slice 7: attach the live watch stream to the LIVE page. attachWatch
      // is a no-op (null) when the page cannot screencast — the run
      // proceeds unwatched rather than failing.
      if (this.opts.watch) {
        this.watchDetach = await attachWatch(page, this.opts.runId);
      }
      await this.emitTimeline({
        type: "browser",
        summary: startUrl ? `Browser recording started — ${startUrl}` : "Browser recording started",
        payload: { startUrl: startUrl ?? null, headless: this.opts.headless ?? true },
      });
      if (startUrl) await page.goto(startUrl);
      return { page };
    } catch (err) {
      await this.teardown();
      throw err;
    }
  }

  /** Record one timeline step (called by the agent's browser tool per action). */
  async recordAction(summary: string, payload?: Record<string, unknown>): Promise<void> {
    if (this.stopped) throw new Error("AgentRunRecorder: already stopped");
    if (!this.browser) throw new Error("AgentRunRecorder: not started");
    this.stepCount += 1;
    await this.emitTimeline({
      type: "browser",
      summary,
      payload: { step: this.stepCount, ...(payload ?? {}) },
    });
  }

  /** Stop tracing, close the browser, finalize artifacts. Idempotent. */
  async stop(): Promise<StoppedRecording> {
    if (this.stopped) {
      return this.stoppedResult();
    }
    this.stopped = true;
    let videoPath: string | null = null;
    try {
      if (this.context) {
        // Capture the video path BEFORE close — closing finalizes the file.
        try {
          videoPath = await this.context.videoPath();
        } catch {
          videoPath = null;
        }
        await this.context.tracingStop(this.tracePath);
        await this.context.close();
      }
      // Fallback: some launchers only materialize the file on close.
      if (!videoPath) videoPath = await this.findVideoOnDisk();
      const sizeBytes = await this.sumSizes([videoPath, this.tracePath]);
      await this.emitTimeline({
        type: "browser",
        summary: `Browser recording stopped — ${this.stepCount} step(s)`,
        payload: { stepCount: this.stepCount, videoPath, tracePath: this.tracePath, sizeBytes },
      });
      return { videoPath, tracePath: this.tracePath, stepCount: this.stepCount, sizeBytes, artifactDir: this.opts.artifactDir };
    } finally {
      await this.teardown();
    }
  }

  private async stoppedResult(): Promise<StoppedRecording> {
    const sizeBytes = await this.sumSizes([null, this.tracePath]);
    return {
      videoPath: null,
      tracePath: this.tracePath,
      stepCount: this.stepCount,
      sizeBytes,
      artifactDir: this.opts.artifactDir,
    };
  }

  private async teardown(): Promise<void> {
    try {
      // Slice 7: stop the live frames FIRST — the watch stream must end
      // the moment the run finishes (or fails to start), before the
      // browser closes.
      if (this.watchDetach) {
        const detach = this.watchDetach;
        this.watchDetach = null;
        await detach().catch(() => undefined);
      }
      if (this.browser) await this.browser.close();
    } catch {
      // Best-effort: never mask the original error.
    } finally {
      this.browser = null;
      this.context = null;
      if (this.slotHeld) {
        this.slotHeld = false;
        releaseSlot();
      }
    }
  }

  private async emitTimeline(event: AgentRunEventInput): Promise<void> {
    await this.opts.onTimelineEvent?.(event);
  }

  private async findVideoOnDisk(): Promise<string | null> {
    try {
      const entries = await fs.readdir(this.opts.artifactDir);
      const webm = entries.filter((e) => e.endsWith(".webm")).sort();
      return webm.length ? path.join(this.opts.artifactDir, webm[webm.length - 1]!) : null;
    } catch {
      return null;
    }
  }

  private async sumSizes(paths: Array<string | null>): Promise<number> {
    let total = 0;
    for (const p of paths) {
      if (!p) continue;
      try {
        const st = await fs.stat(p);
        if (st.isFile()) total += st.size;
      } catch {
        // Missing artifact contributes 0 — the recording row records nulls.
      }
    }
    return total;
  }
}

/** retentionUntil for a fresh recording (decision c: 30 days, then summarize). */
export function recordingRetentionUntil(from: Date = new Date()): Date {
  return new Date(from.getTime() + RECORDING_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}
