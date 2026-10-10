// ShapesOS — Phase 8: recorded browser tools for agents.
//
//   browser_open(url)              web, safe  — open a page, read its title and text
//   browser_extract(selector, url) web, safe  — the text of elements matching a selector
//   browser_act({ steps, url })    web, spend — click / fill / wait / screenshot (asks first;
//                                               automation action browser_act, Tier 2)
//
// Each call is one recorded browser run through the existing recorder
// (executeBrowserRun in ./lifecycle.ts → AgentRunRecorder): its own AgentRun
// of kind "browser" under the calling run (parentRunId), with video, trace
// and a step-by-step timeline, so the Runs page's watch / replay shows it.
// The calling run gets one event linking to that browser run.
//
// SSRF: the start URL goes through assertSafeUrl (lib/safe-url.ts) before a
// browser is launched, and the same guard checks EVERY request the browser
// makes (navigations a click causes, redirect hops, subresources,
// websockets); refused requests are aborted. Service workers are blocked.
//
// Phase 21A (WS=agentweb): browser_act is now judged step by step against the
// page (lib/agentweb/classify.ts). Before each click or fill the element is
// described (role, name, input type, autocomplete, the form's destination) and
// the safety kernel decides: ordinary steps run; steps that pay, remove, sign
// in, or type into a password / card field STOP the sequence (the person's own
// act, whatever they said yes to); sending and unclear steps run only because
// the person confirmed this call. A click that carries the page to another
// origin also stops the sequence and nothing from that page is read back. Page
// text returned by browser_open / browser_extract / browser_act is third-party
// data: it is labelled so, and registered with the task's taint ledger.
//
// Each call starts from a fresh page: act / extract default to the last page
// browser_open opened in this task. Deploy PR: that page is read back from
// the run timeline (lastBrowserPageForTask) so it survives a hand-off to the
// worker or a call landing on another replica; the in-process map is only a
// cache in front of it. Typed values are never written to the timeline
// (only their length).

import { posix as path } from "node:path";
import { TOOL_RECORDED_EVENT, registerExtraTool, type ToolContext, type ToolDef, type ToolResult } from "@/lib/chat/tools";
import { assertSafeUrl, UnsafeUrlError } from "@/lib/safe-url";
import { appendAgentRunEvent, lastBrowserPageForTask } from "./service";
import { executeBrowserRun, RecorderBusyError, type BrowserRunRequest, type BrowserRunDeps, type BrowserRunResult } from "./lifecycle";
import type { BrowserLauncher, RecorderPage, RequestGuard } from "./recorder";
import type { AgentRunEventInput } from "./types";
// Phase 21A (WS=agentweb): page-aware gate for browser_act, and page text kept as untrusted data.
import { capabilitiesFor, checkNavigation } from "@/lib/agentweb/capabilities";
import { SafetyKernel } from "@/lib/agentweb/kernel";
import { wrapUntrusted } from "@/lib/agentweb/reader";
import { taskKeyOf, webTasks } from "@/lib/agentweb/tasks";

type Ctx = ToolContext & { threadId?: string };

export interface BrowserToolDeps {
  runBrowser: (req: BrowserRunRequest, deps: BrowserRunDeps) => Promise<BrowserRunResult>;
  /** Throws UnsafeUrlError for private / internal / non-http URLs. Returns the normalised URL. */
  checkUrl: (url: string) => Promise<string>;
  launcher?: BrowserLauncher;
  recordEvent: (workspaceId: string, runId: string, event: AgentRunEventInput) => Promise<void>;
  /** The task's last opened page from shared state (any instance). */
  lastPage?: (workspaceId: string, task: { threadId?: string | null; runId?: string | null }) => Promise<string | null>;
}

export const defaultBrowserToolDeps: BrowserToolDeps = {
  runBrowser: executeBrowserRun,
  checkUrl: (url) => assertSafeUrl(url),
  recordEvent: async (ws, runId, event) => {
    await appendAgentRunEvent(ws, runId, event);
  },
  lastPage: lastBrowserPageForTask,
};

export const MAX_STEPS = 20;
const TEXT_CAP = 6000;
const GUARD_CACHE_MS = 60_000;

/** A request guard over checkUrl, cached per origin for a minute. */
export function makeRequestGuard(checkUrl: (url: string) => Promise<string>): RequestGuard {
  const cache = new Map<string, { ok: boolean; at: number }>();
  return async (raw: string) => {
    let origin: string;
    try {
      const u = new URL(raw);
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      origin = u.origin;
    } catch {
      return false;
    }
    const hit = cache.get(origin);
    if (hit && Date.now() - hit.at < GUARD_CACHE_MS) return hit.ok;
    const ok = await checkUrl(raw).then(
      () => true,
      () => false,
    );
    cache.set(origin, { ok, at: Date.now() });
    return ok;
  };
}

/** Last page opened per task (thread, else run) — a cache in front of deps.lastPage. */
const lastPage = new Map<string, string>();
function taskKey(ctx: Ctx): string | null {
  return ctx.threadId ? `t:${ctx.threadId}` : ctx.runId ? `r:${ctx.runId}` : null;
}

export type BrowserStep =
  | { action: "click"; selector: string }
  | { action: "fill"; selector: string; value: string }
  | { action: "wait"; selector?: string; ms?: number }
  | { action: "screenshot" };

/** Validate the steps a model sent (array or JSON string). Throws with a fix. */
export function parseSteps(raw: unknown): BrowserStep[] {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      throw new Error('steps must be a JSON array, e.g. [{"action":"click","selector":"#buy"}]');
    }
  }
  if (!Array.isArray(v) || v.length === 0) throw new Error("steps must be a non-empty array.");
  if (v.length > MAX_STEPS) throw new Error(`At most ${MAX_STEPS} steps per call.`);
  return v.map((s, i) => {
    const o = (s ?? {}) as Record<string, unknown>;
    const sel = typeof o.selector === "string" && o.selector.trim() ? o.selector.trim().slice(0, 500) : undefined;
    switch (o.action) {
      case "click":
        if (!sel) throw new Error(`Step ${i + 1}: click needs a selector.`);
        return { action: "click", selector: sel };
      case "fill":
        if (!sel) throw new Error(`Step ${i + 1}: fill needs a selector.`);
        if (typeof o.value !== "string") throw new Error(`Step ${i + 1}: fill needs a value.`);
        return { action: "fill", selector: sel, value: o.value.slice(0, 5000) };
      case "wait": {
        const ms = typeof o.ms === "number" && Number.isFinite(o.ms) ? Math.min(Math.max(o.ms, 0), 30_000) : undefined;
        if (!sel && ms === undefined) throw new Error(`Step ${i + 1}: wait needs a selector or ms.`);
        return { action: "wait", ...(sel ? { selector: sel } : {}), ...(ms !== undefined ? { ms } : {}) };
      }
      case "screenshot":
        return { action: "screenshot" };
      default:
        throw new Error(`Step ${i + 1}: action must be click, fill, wait or screenshot.`);
    }
  });
}

/** Page text returned to the model: labelled as third-party data and remembered as untrusted (taint ledger). */
async function untrustedText(ctx: Ctx, text: string, url: string): Promise<string> {
  let origin = "unknown";
  try {
    origin = new URL(url).origin;
  } catch {
    /* keep unknown */
  }
  const task = await webTasks.ensure(taskKeyOf(ctx), ctx.workspaceId).catch(() => null);
  task?.kernel.ledger.register(text, origin, "untrusted");
  return wrapUntrusted(text, origin);
}

function need<T>(fn: T | undefined, what: string): T {
  if (!fn) throw new Error(`This browser cannot ${what}.`);
  return fn;
}

async function pageText(page: RecorderPage): Promise<string> {
  const parts = page.extract ? await page.extract("body", { limit: 1 }).catch(() => []) : [];
  const text = (parts[0] ?? "").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP)}…` : text;
}

async function resolveStartUrl(deps: BrowserToolDeps, ctx: Ctx, raw: unknown): Promise<string> {
  const given = typeof raw === "string" && raw.trim() ? raw.trim() : null;
  const key = taskKey(ctx);
  let url = given ?? (key ? lastPage.get(key) : undefined);
  if (!url && key && deps.lastPage) {
    url = (await deps.lastPage(ctx.workspaceId, { threadId: ctx.threadId, runId: ctx.runId }).catch(() => null)) ?? undefined;
  }
  if (!url) throw new Error("Say which page to use (url), or open one with browser_open first.");
  try {
    return await deps.checkUrl(url);
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw new Error(`That address can't be opened: ${err.message}`);
    throw err;
  }
}

function friendly(err: unknown): never {
  if (err instanceof RecorderBusyError) throw new Error("The browser is busy with another recording; try again shortly.");
  throw err;
}

export function createBrowserTools(deps: BrowserToolDeps = defaultBrowserToolDeps): ToolDef[] {
  const guard = makeRequestGuard(deps.checkUrl);

  async function run(
    ctx: Ctx,
    tool: string,
    startUrl: string,
    work: (page: RecorderPage, recordAction: (s: string, p?: Record<string, unknown>) => Promise<void>, artifactDir: string) => Promise<Record<string, unknown>>,
  ): Promise<BrowserRunResult> {
    try {
      return await deps.runBrowser(
        {
          workspaceId: ctx.workspaceId,
          startedBy: ctx.userId,
          threadId: ctx.threadId,
          parentRunId: ctx.runId,
          agentKey: ctx.agentKey,
          startUrl,
          headless: true,
          watch: true,
          guardRequest: guard,
          agentState: { tool, projectId: ctx.projectId },
        },
        {
          launcher: deps.launcher,
          execute: async ({ page, recordAction, artifactDir }) => ({ result: await work(page, recordAction, artifactDir) }),
        },
      );
    } catch (err) {
      friendly(err);
    }
  }

  async function linkEvent(ctx: Ctx, summary: string, payload: Record<string, unknown>): Promise<void> {
    if (!ctx.runId) return;
    await deps.recordEvent(ctx.workspaceId, ctx.runId, { type: "browser", summary: summary.slice(0, 500), payload }).catch(() => undefined);
  }

  function remember(ctx: Ctx, url: string): void {
    const key = taskKey(ctx);
    if (!key) return;
    lastPage.set(key, url);
    if (lastPage.size > 500) lastPage.delete(lastPage.keys().next().value as string);
  }

  function done(summary: string, details: Record<string, unknown>): ToolResult {
    return { summary, details: { ...details, [TOOL_RECORDED_EVENT]: true } };
  }

  const browser_open: ToolDef = {
    name: "browser_open",
    description:
      "Open a public web page in a recorded browser and read its title and visible text. Private and internal addresses are refused.",
    kind: "safe",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: { url: { type: "string", description: "The http(s) page to open (required)." } },
      required: ["url"],
    },
    async execute(rawCtx, args) {
      const ctx = rawCtx as Ctx;
      if (typeof args.url !== "string" || !args.url.trim()) throw new Error("Say which page to open (url).");
      const url = await resolveStartUrl(deps, ctx, args.url);
      const res = await run(ctx, "browser_open", url, async (page, recordAction) => {
        const title = page.title ? await page.title().catch(() => "") : "";
        const finalUrl = page.url ? page.url() : url;
        const text = await pageText(page);
        await recordAction(`Read ${title || finalUrl}`, { url: finalUrl, title, chars: text.length });
        return { url: finalUrl, title, text };
      });
      const r = res.result as { url: string; title: string; text: string };
      remember(ctx, r.url || url);
      await linkEvent(ctx, `Opened ${r.title || r.url} in a recorded browser`, {
        tool: "browser_open",
        url: r.url,
        title: r.title,
        browserRunId: res.runId,
      });
      return done(`${r.title ? `${r.title} — ` : ""}${r.url}\n${await untrustedText(ctx, r.text || "(no visible text)", r.url)}`, {
        url: r.url,
        title: r.title,
        browserRunId: res.runId,
      });
    },
  };

  const browser_extract: ToolDef = {
    name: "browser_extract",
    description:
      "Read the text of the elements matching a CSS selector on a page (default: the last page opened with browser_open), in a recorded browser.",
    kind: "safe",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector (required), e.g. \"main h2\"." },
        url: { type: "string", description: "Page to read (default: the last page opened in this task)." },
      },
      required: ["selector"],
    },
    async execute(rawCtx, args) {
      const ctx = rawCtx as Ctx;
      const selector = typeof args.selector === "string" ? args.selector.trim().slice(0, 500) : "";
      if (!selector) throw new Error("Say what to read (selector).");
      const url = await resolveStartUrl(deps, ctx, args.url);
      const res = await run(ctx, "browser_extract", url, async (page, recordAction) => {
        const items = await need(page.extract, "read elements").call(page, selector, { limit: 50 });
        await recordAction(`Read ${items.length} element${items.length === 1 ? "" : "s"} matching ${selector}`, {
          selector,
          count: items.length,
        });
        return { url: page.url ? page.url() : url, items };
      });
      const r = res.result as { url: string; items: string[] };
      remember(ctx, r.url || url);
      await linkEvent(ctx, `Read ${r.items.length} element${r.items.length === 1 ? "" : "s"} (${selector}) in a recorded browser`, {
        tool: "browser_extract",
        url: r.url,
        selector,
        count: r.items.length,
        browserRunId: res.runId,
      });
      const text = r.items.map((t, i) => `${i + 1}. ${t.trim()}`).join("\n");
      return done(
        r.items.length ? await untrustedText(ctx, text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP)}…` : text, r.url) : `Nothing on ${r.url} matches ${selector}.`,
        { url: r.url, count: r.items.length, browserRunId: res.runId },
      );
    },
  };

  const browser_act: ToolDef = {
    name: "browser_act",
    description:
      'Act on a page in a recorded browser: a list of steps, each {"action":"click","selector":…}, {"action":"fill","selector":…,"value":…}, {"action":"wait","selector":… or "ms":…} or {"action":"screenshot"}. Starts from url (default: the last page opened). Asks first.',
    kind: "spend",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: {
        steps: { type: "array", description: `Up to ${MAX_STEPS} steps, run in order (required).` },
        url: { type: "string", description: "Page to start from (default: the last page opened in this task)." },
      },
      required: ["steps"],
    },
    async execute(rawCtx, args) {
      const ctx = rawCtx as Ctx;
      const steps = parseSteps(args.steps);
      const url = await resolveStartUrl(deps, ctx, args.url);
      const res = await run(ctx, "browser_act", url, async (page, recordAction, artifactDir) => {
        let n = 0;
        let stopped: { step: number; reason: string; leftSite: boolean } | null = null;
        const task = await webTasks.ensure(taskKeyOf(ctx), ctx.workspaceId);
        const kernel = new SafetyKernel({ caps: capabilitiesFor(url), ledger: task.kernel.ledger });
        for (const step of steps) {
          n += 1;
          // Phase 21A: judge the step against the page before it runs.
          if ((step.action === "click" || step.action === "fill") && page.describe) {
            const el = await page.describe(step.selector).catch(() => null);
            if (el) {
              const cur = page.url ? page.url() : url;
              const at = { url: cur, origin: new URL(cur).origin };
              const d = kernel.authorize(
                step.action === "click"
                  ? { kind: "click", element: { ref: "s", ...el }, page: at }
                  : { kind: "type", element: { ref: "s", ...el }, page: at, value: step.value },
              );
              if (d.decision !== "allow" && (d.decision !== "confirm" || !ctx.confirmed)) {
                stopped = { step: n, reason: d.reasons.join("; "), leftSite: false };
                await recordAction(`Stopped before step ${n}: ${stopped.reason}`, { action: step.action, selector: step.selector, klass: d.klass, tier: d.tier, decision: d.decision });
                break;
              }
            }
          }
          if (step.action === "click") {
            await need(page.click, "click").call(page, step.selector);
            await recordAction(`Clicked ${step.selector}`, { action: "click", selector: step.selector });
            // A click that carried the page to another origin pauses the sequence; that page is not read back.
            const landed = page.url ? page.url() : url;
            const nav = checkNavigation(kernel.caps, landed);
            if (!nav.ok) {
              stopped = { step: n, reason: `the page moved to ${nav.reason === "new-origin" ? nav.origin : "another address"}, which this task did not start with`, leftSite: true };
              await recordAction(`Paused after step ${n}: ${stopped.reason}`, { action: "click", selector: step.selector, decision: "paused" });
              break;
            }
          } else if (step.action === "fill") {
            await need(page.fill, "fill fields").call(page, step.selector, step.value);
            // Never the value itself: it may be a password or personal data.
            await recordAction(`Filled ${step.selector}`, { action: "fill", selector: step.selector, chars: step.value.length });
          } else if (step.action === "wait") {
            await need(page.waitFor, "wait").call(page, { selector: step.selector, ms: step.ms });
            await recordAction(step.selector ? `Waited for ${step.selector}` : `Waited ${step.ms} ms`, { ...step });
          } else {
            const file = `step-${Date.now()}-${n}.png`;
            await need(page.screenshot, "take screenshots").call(page, path.join(artifactDir, file));
            await recordAction("Took a screenshot", { action: "screenshot", file });
          }
        }
        const left = stopped?.leftSite === true;
        const title = left ? "" : page.title ? await page.title().catch(() => "") : "";
        return { url: page.url ? page.url() : url, title, text: left ? "" : await pageText(page), ...(stopped ? { stopped } : {}) };
      });
      const r = res.result as { url: string; title: string; text: string; stopped?: { step: number; reason: string; leftSite: boolean } };
      remember(ctx, r.stopped?.leftSite ? url : r.url || url);
      await linkEvent(ctx, `Ran ${r.stopped ? r.stopped.step - (r.stopped.leftSite ? 0 : 1) : steps.length} of ${steps.length} browser step${steps.length === 1 ? "" : "s"} on ${r.title || r.url}`, {
        tool: "browser_act",
        url: r.url,
        steps: steps.map((s) => (s.action === "fill" ? { action: "fill", selector: s.selector } : s)),
        ...(r.stopped ? { stoppedAt: r.stopped.step, stoppedBecause: r.stopped.reason } : {}),
        browserRunId: res.runId,
      });
      if (r.stopped) {
        const ran = r.stopped.leftSite ? r.stopped.step : r.stopped.step - 1;
        const text = r.text ? `\n${await untrustedText(ctx, r.text, r.url)}` : "";
        return done(
          r.stopped.leftSite
            ? `Ran ${ran} of ${steps.length} steps, then paused: ${r.stopped.reason}. Nothing from that page was read. Ask the person before going there.`
            : `Ran ${ran} of ${steps.length} steps, then stopped before step ${r.stopped.step}: ${r.stopped.reason}. ShapesOS does not take money, delete things or fill passwords for an agent: tell the person what is needed so they can do it themselves.${text}`,
          { url: r.url, title: r.title, browserRunId: res.runId, stoppedAt: r.stopped.step },
        );
      }
      return done(`Ran ${steps.length} step${steps.length === 1 ? "" : "s"}; now on ${r.title ? `${r.title} — ` : ""}${r.url}\n${await untrustedText(ctx, r.text, r.url)}`, {
        url: r.url,
        title: r.title,
        browserRunId: res.runId,
      });
    },
  };

  return [browser_open, browser_extract, browser_act];
}

export const BROWSER_TOOL_NAMES = ["browser_open", "browser_extract", "browser_act"] as const;

let registered = false;
export function registerBrowserTools(deps: BrowserToolDeps = defaultBrowserToolDeps): void {
  if (registered) return;
  registered = true;
  for (const t of createBrowserTools(deps)) registerExtraTool(t);
}

registerBrowserTools();
