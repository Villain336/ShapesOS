// ShapesOS — Phase 21A (WS=agentweb): the server BrowserProvider (Playwright Chromium).
//
// The a11y-tree channel: page.ariaSnapshot({ mode: "ai" }) gives every control
// a stable ref (e12) that page.locator("aria-ref=e12") resolves, and a small DOM
// read adds what the page-aware classifier needs (input type, autocomplete, the
// form and its destination). Vision is a stub: screenshots are saved as
// evidence, and nothing reads them.
//
// Isolation (the "agent profile"): a fresh browser context per task with no
// cookies and no user logins, service workers blocked, downloads off, no
// permissions granted, popups folded into the one page. Every request passes the
// SSRF guard (lib/safe-url.ts), and a DOCUMENT navigation of the main frame to
// an origin the task does not allow is aborted before it is sent: a redirect or
// a script cannot carry the agent off-site, it just pauses the step.
//
// Honest identification: the user agent carries "ShapesOS-Agent/1.0". No
// stealth, no CAPTCHA solving: a block is reported, not worked around.

import { promises as fs } from "node:fs";
import type { Browser, BrowserContext, Page } from "playwright";
import { checkNavigation, grantOrigin, type TaskCapabilities } from "./capabilities";
import { cleanLabel } from "./elements";
import { parseAriaSnapshot } from "./aria";
import type { BlockedNavigation, BrowserProvider, BrowserSession, OpenOptions, PageSnapshot, ScreenshotResult, StepOutcome, TabInfo } from "./provider";
import type { ElementInfo, FieldInfo } from "./types";

export const MAX_BROWSERS = 2;
const NAV_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 10_000;
const MAX_CONTROLS = 120;
let open = 0;

export interface ServerProviderDeps {
  /** SSRF guard for every request. */
  checkUrl: (url: string) => Promise<string>;
  /** Appended to the browser's own user agent. */
  agentToken?: string;
}

export class PlaywrightProvider implements BrowserProvider {
  readonly id = "server" as const;
  constructor(private readonly deps: ServerProviderDeps) {}

  async available(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const { chromium } = await import("playwright");
      await fs.access(chromium.executablePath());
      if (open >= MAX_BROWSERS) return { ok: false, reason: `${MAX_BROWSERS} browsers are already running on this server; try again shortly` };
      return { ok: true };
    } catch {
      return { ok: false, reason: "Chromium is not installed on this server" };
    }
  }

  async open(opts: OpenOptions): Promise<BrowserSession> {
    if (open >= MAX_BROWSERS) throw new Error(`${MAX_BROWSERS} browsers are already running on this server; try again shortly.`);
    open += 1;
    try {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({ headless: true });
      const probe = await browser.newContext();
      const baseUa = await (await probe.newPage()).evaluate(() => navigator.userAgent);
      await probe.close();
      const context = await browser.newContext({
        userAgent: `${baseUa} ${this.deps.agentToken ?? "ShapesOS-Agent/1.0"}`,
        viewport: { width: 1280, height: 800 },
        serviceWorkers: "block",
        acceptDownloads: false,
      });
      const session = new PlaywrightSession(browser, context, opts.caps, this.deps);
      await session.init();
      opts.signal?.addEventListener("abort", () => void session.close(), { once: true });
      return session;
    } catch (err) {
      open -= 1;
      throw err;
    }
  }
}

/** Facts about a control the aria tree does not carry; evaluated in the page. */
interface DomFacts {
  tag: string;
  fieldName?: string;
  type?: string;
  autocomplete?: string;
  href?: string;
  disabled?: boolean;
  form?: { action: string; method: string; fields: FieldInfo[] };
}

const READ_DOM = (el: Element): DomFacts => {
  const e = el as HTMLInputElement & HTMLAnchorElement & { form?: HTMLFormElement | null };
  const form = e.form ?? (el.closest("form") as HTMLFormElement | null);
  return {
    tag: el.tagName.toLowerCase(),
    fieldName: el.tagName === "A" ? undefined : (el.getAttribute("name") ?? undefined),
    type: (el.getAttribute("type") ?? undefined)?.toLowerCase(),
    autocomplete: el.getAttribute("autocomplete")?.toLowerCase() ?? undefined,
    href: el.tagName === "A" ? (el as HTMLAnchorElement).href : undefined,
    disabled: (e as HTMLButtonElement).disabled === true || undefined,
    form: form
      ? {
          action: form.action,
          method: (form.method || "get").toLowerCase(),
          fields: [...form.elements]
            .filter((f) => ["INPUT", "SELECT", "TEXTAREA"].includes(f.tagName) && !["submit", "button", "reset", "image", "hidden"].includes((f.getAttribute("type") ?? "").toLowerCase()))
            .map((f) => ({
              name: f.getAttribute("name") ?? undefined,
              type: f.tagName === "TEXTAREA" ? "textarea" : f.tagName === "SELECT" ? "select" : (f.getAttribute("type") ?? "text").toLowerCase(),
              autocomplete: f.getAttribute("autocomplete")?.toLowerCase() ?? undefined,
              label: (f.getAttribute("aria-label") ?? f.getAttribute("placeholder") ?? "").slice(0, 80),
            })),
        }
      : undefined,
  };
};

class PlaywrightSession implements BrowserSession {
  readonly provider = "server" as const;
  private page!: Page;
  private blocked: BlockedNavigation | null = null;
  private closed = false;

  constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly caps: TaskCapabilities,
    private readonly deps: ServerProviderDeps,
  ) {}

  async init(): Promise<void> {
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    this.page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    await this.context.route("**/*", async (route) => {
      const req = route.request();
      const url = req.url();
      if (/^(data|blob|about):/i.test(url)) return route.continue();
      if (req.isNavigationRequest() && req.frame() === this.page.mainFrame()) {
        const nav = checkNavigation(this.caps, url);
        if (!nav.ok) {
          this.blocked = { url, origin: nav.reason === "new-origin" ? nav.origin : null, reason: nav.reason === "new-origin" ? "new-origin" : "bad-scheme" };
          return route.abort("blockedbyclient");
        }
      }
      const ok = await this.deps.checkUrl(url).then(() => true, () => false);
      if (!ok) {
        if (req.isNavigationRequest() && req.frame() === this.page.mainFrame()) this.blocked = { url, origin: null, reason: "unsafe-address" };
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    await this.context.routeWebSocket(/.*/, async (ws) => {
      const httpUrl = ws.url().replace(/^ws(s?):/i, "http$1:");
      const ok = await this.deps.checkUrl(httpUrl).then(() => true, () => false);
      if (ok) ws.connectToServer();
      else await ws.close({ code: 1008, reason: "blocked" });
    });
    // A link that opens a new tab is folded into the one page when its address is allowed.
    this.context.on("page", (p) => {
      if (p === this.page) return;
      void (async () => {
        await p.waitForLoadState("domcontentloaded").catch(() => undefined);
        const target = p.url();
        await p.close().catch(() => undefined);
        if (target && target !== "about:blank" && checkNavigation(this.caps, target).ok) await this.page.goto(target).catch(() => undefined);
      })();
    });
  }

  url(): string {
    return this.page.url();
  }

  allowOrigin(origin: string): void {
    grantOrigin(this.caps, origin);
  }

  private takeBlocked(): BlockedNavigation | undefined {
    const b = this.blocked ?? undefined;
    this.blocked = null;
    return b;
  }

  async navigate(url: string) {
    this.blocked = null;
    let status = 0;
    try {
      const res = await this.page.goto(url, { waitUntil: "domcontentloaded" });
      status = res?.status() ?? 0;
    } catch (err) {
      const blocked = this.takeBlocked();
      if (blocked) return { url: this.page.url(), navigated: false, blocked, title: await this.title(), status: 0 };
      throw new Error(`The page could not be opened: ${err instanceof Error ? err.message.split("\n")[0] : "network error"}`);
    }
    return { url: this.page.url(), navigated: true, title: await this.title(), status };
  }

  private async title(): Promise<string> {
    return this.page.title().catch(() => "");
  }

  async snapshot(): Promise<PageSnapshot> {
    const tree = await this.page.ariaSnapshot({ mode: "ai" });
    const found = parseAriaSnapshot(tree).slice(0, MAX_CONTROLS);
    const controls: ElementInfo[] = [];
    for (let i = 0; i < found.length; i += 20) {
      const batch = found.slice(i, i + 20);
      const facts = await Promise.all(batch.map((c) => this.page.locator(`aria-ref=${c.ref}`).evaluate(READ_DOM).catch(() => null)));
      batch.forEach((c, j) => {
        const f = facts[j];
        controls.push({
          ref: c.ref,
          role: c.role,
          name: cleanLabel(c.name),
          ...(f?.tag ? { tag: f.tag } : {}),
          ...(f?.fieldName ? { fieldName: f.fieldName } : {}),
          ...(f?.type ? { type: f.type } : {}),
          ...(f?.autocomplete ? { autocomplete: f.autocomplete } : {}),
          ...((f?.href ?? c.url) ? { href: f?.href ?? c.url } : {}),
          ...(f?.form ? { form: f.form } : {}),
          ...(c.disabled || f?.disabled ? { disabled: true } : {}),
        });
      });
    }
    return { url: this.page.url(), title: await this.title(), controls };
  }

  async html(): Promise<string> {
    return this.page.content();
  }

  private async settle(before: string): Promise<StepOutcome> {
    await this.page.waitForLoadState("domcontentloaded", { timeout: 3_000 }).catch(() => undefined);
    const blocked = this.takeBlocked();
    return { url: this.page.url(), navigated: this.page.url() !== before, ...(blocked ? { blocked } : {}) };
  }

  async click(ref: string): Promise<StepOutcome> {
    this.blocked = null;
    const before = this.page.url();
    await this.page.locator(`aria-ref=${ref}`).click({ timeout: ACTION_TIMEOUT_MS });
    return this.settle(before);
  }

  async type(ref: string, text: string): Promise<StepOutcome> {
    const before = this.page.url();
    const loc = this.page.locator(`aria-ref=${ref}`);
    const tag = await loc.evaluate((el) => el.tagName.toLowerCase(), { timeout: ACTION_TIMEOUT_MS });
    if (tag === "select") await loc.selectOption(text, { timeout: ACTION_TIMEOUT_MS });
    else await loc.fill(text, { timeout: ACTION_TIMEOUT_MS });
    return { url: before, navigated: false };
  }

  async screenshot(): Promise<ScreenshotResult> {
    return { png: await this.page.screenshot({ type: "png" }) };
  }

  async tabs(): Promise<TabInfo[]> {
    const pages = this.context.pages();
    return Promise.all(pages.map(async (p, i) => ({ id: `t${i + 1}`, url: p.url(), title: await p.title().catch(() => ""), active: p === this.page })));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    open = Math.max(0, open - 1);
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
  }
}
