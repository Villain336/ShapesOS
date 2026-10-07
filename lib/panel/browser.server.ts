// ShapesOS — Phase 19B (WS=panel): a persona's browser, over the existing
// Playwright recorder (lib/agents/runs/recorder.ts AgentRunRecorder).
// Commercial layer (entitlement dress_rehearsal). See lib/panel/README.md.
//
// Ported from the prototype's src/simulation/browser.ts + the locator half of
// pagemaster.ts. One persona = one recorded headless context: every request
// passes the walk's guard (SSRF + analytics stripping, lib/panel/targets.ts),
// pages served from our own storage are fulfilled by the recorder without
// touching the network, the behaviour tracker is injected before the first
// navigation, and the Playwright trace is handed back on close (the runner
// stores it in blob storage; the scratch directory is removed).
// The recorder's in-process semaphore (MARKETR_MAX_BROWSER_RECORDINGS)
// bounds how many browsers run at once; RecorderBusyError means "wait".

import { promises as fs } from "node:fs";
import type { Locator, Page } from "playwright";
import { AgentRunRecorder, scratchArtifactDir, type BrowserLauncher } from "@/lib/agents/runs/recorder";
import type { PageOutline, SectionHit, WalkPage } from "./pagemaster";
import { servedResponse, type ServedSite } from "./targets";
import { coerceTrackerState, TRACKER_SCRIPT, type TrackerState } from "./tracker";

export interface OpenedWalk {
  page: WalkPage;
  /** Stop recording; returns the Playwright trace (null when there is none). */
  close(): Promise<{ traceBytes: Buffer | null }>;
}

export interface OpenWalkPageOptions {
  /** Unique per persona walk (names the scratch directory). */
  walkKey: string;
  startUrl: string;
  served: ServedSite | null;
  guard: (url: string) => Promise<boolean>;
  launcher?: BrowserLauncher;
}

export type OpenWalkPage = (opts: OpenWalkPageOptions) => Promise<OpenedWalk>;

const ACTION_TIMEOUT_MS = 8_000;

/** The page's real outline: title, visible headings, buttons / links, form labels. */
const OUTLINE_SCRIPT = `(() => {
  var visible = function (el) {
    var r = el.getBoundingClientRect();
    var st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  };
  var text = function (el) { return (el.textContent || "").replace(/\\s+/g, " ").trim(); };
  var uniq = function (xs) { var out = []; xs.forEach(function (x) { if (x && out.indexOf(x) < 0) out.push(x); }); return out; };
  var all = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)).filter(visible); };
  return {
    title: document.title,
    headings: uniq(all("h1, h2, h3").map(text)).slice(0, 30),
    actions: uniq(all("a[href], button, [role=button], input[type=submit]").map(function (el) {
      return el.tagName === "INPUT" && el.value ? el.value : (el.getAttribute("aria-label") || text(el));
    })).slice(0, 30),
    fields: uniq(all("label").map(function (l) {
      var c = l.cloneNode(true);
      Array.prototype.slice.call(c.querySelectorAll("input, textarea, select")).forEach(function (i) { i.remove(); });
      return text(c);
    })).slice(0, 15),
  };
})()`;

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** The PageMaster's view of a live Playwright page. */
export class PlaywrightWalkPage implements WalkPage {
  constructor(private readonly page: Page) {}

  url(): string {
    return this.page.url();
  }

  async outline(): Promise<PageOutline> {
    // A plain string, not a function: a transpiled function can carry
    // bundler helpers (e.g. esbuild's __name) that don't exist in the page.
    return (await this.page.evaluate(OUTLINE_SCRIPT)) as PageOutline;
  }

  private async section(target: string): Promise<{ heading: string; sectionId?: string; loc: Locator } | null> {
    if (target.startsWith("#")) {
      const loc = this.page.locator(target);
      if ((await loc.count()) === 0) return null;
      return { heading: target, sectionId: target.slice(1), loc: loc.first() };
    }
    const heading = this.page.getByRole("heading", { name: target });
    if ((await heading.count()) === 0) return null;
    const h = heading.first();
    const headingText = clean((await h.textContent()) ?? target);
    const ancestor = h.locator("xpath=ancestor::section[1]");
    const loc = (await ancestor.count()) > 0 ? ancestor.first() : h.locator("xpath=..");
    const id = await loc.getAttribute("id").catch(() => null);
    return { heading: headingText, ...(id ? { sectionId: id } : {}), loc };
  }

  async scrollTo(target: string): Promise<SectionHit | null> {
    const s = await this.section(target);
    if (!s) return null;
    await s.loc.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS }).catch(() => undefined);
    const text = (await s.loc.innerText({ timeout: ACTION_TIMEOUT_MS }).catch(() => "")) as string;
    return { heading: s.heading, ...(s.sectionId ? { sectionId: s.sectionId } : {}), text };
  }

  async read(target: string): Promise<(SectionHit & { shot: Buffer | null }) | null> {
    const hit = await this.scrollTo(target);
    if (!hit) return null;
    const s = await this.section(target);
    const shot = s ? await s.loc.screenshot({ timeout: ACTION_TIMEOUT_MS }).catch(() => this.page.screenshot().catch(() => null)) : null;
    return { ...hit, shot };
  }

  async click(name: string): Promise<{ status: "clicked" | "not-found" | "hidden"; shot: Buffer | null }> {
    for (const c of [this.page.getByRole("button", { name }), this.page.getByRole("link", { name })]) {
      if ((await c.count()) === 0) continue;
      const el = c.first();
      if (!(await el.isVisible().catch(() => false))) return { status: "hidden", shot: null };
      await el.click({ timeout: ACTION_TIMEOUT_MS });
      await this.page.waitForLoadState("domcontentloaded", { timeout: ACTION_TIMEOUT_MS }).catch(() => undefined);
      return { status: "clicked", shot: await this.page.screenshot().catch(() => null) };
    }
    return { status: "not-found", shot: null };
  }

  async fill(label: string, value: string): Promise<boolean> {
    const field = this.page.getByLabel(label);
    if ((await field.count()) === 0) return false;
    await field.first().fill(value, { timeout: ACTION_TIMEOUT_MS });
    return true;
  }

  async goBack(): Promise<boolean> {
    const res = await this.page.goBack({ timeout: ACTION_TIMEOUT_MS }).catch(() => null);
    return res !== null;
  }

  async trackerState(): Promise<TrackerState> {
    return coerceTrackerState(await this.page.evaluate("typeof window.__drGetState === 'function' ? window.__drGetState() : null").catch(() => null));
  }
}

/** One persona's recorded browser on the walk's start URL. */
export async function openRecordedWalkPage(opts: OpenWalkPageOptions): Promise<OpenedWalk> {
  const artifactDir = scratchArtifactDir(`panel-${opts.walkKey}`);
  const rec = new AgentRunRecorder({
    runId: `panel-${opts.walkKey}`,
    artifactDir,
    headless: true,
    guardRequest: opts.guard,
    ...(opts.served ? { fulfillRequest: async (u: string) => servedResponse(opts.served!, u) } : {}),
    ...(opts.launcher ? { launcher: opts.launcher } : {}),
  });
  const { page: rp } = await rec.start();
  const page = rp.playwright?.();
  if (!page) {
    await rec.stop().catch(() => undefined);
    throw new Error("The browser launcher has no Playwright page; a page walk needs the real recorder.");
  }
  try {
    await page.addInitScript(TRACKER_SCRIPT);
    await page.goto(opts.startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch (err) {
    await rec.stop().catch(() => undefined);
    await fs.rm(artifactDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  return {
    page: new PlaywrightWalkPage(page),
    async close() {
      const stopped = await rec.stop();
      const traceBytes = await fs.readFile(stopped.tracePath).catch(() => null);
      await fs.rm(artifactDir, { recursive: true, force: true }).catch(() => undefined);
      return { traceBytes };
    },
  };
}
