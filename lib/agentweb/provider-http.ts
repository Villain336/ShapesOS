// ShapesOS — Phase 21A (WS=agentweb): the no-JavaScript BrowserProvider.
//
// Fetches pages, reads their controls and submits plain HTML forms. It runs no
// script, so it cannot use a single-page app; it is what you want for static
// pages (sites our own SiteBuilder publishes, documentation, small business
// sites), costs no browser, and is what the unit tests and evals run on.
//
// Every request is checked twice: the SSRF guard (injected `checkUrl`, in
// production lib/safe-url.ts) and the task's origins. A redirect to an origin
// the task does not allow is NOT requested: the session reports it as blocked
// and keeps the page it was on.

import { scanControls, formDefaults, type ControlNode } from "./elements";
import { attr, findAll, parseHtml, textOf } from "./html";
import { checkNavigation, grantOrigin, type TaskCapabilities } from "./capabilities";
import { classifyResponse, signedNavigationHeaders, type Signer } from "./identity/agent-fetch";
import type { BrowserProvider, BrowserSession, OpenOptions, PageSnapshot, ScreenshotResult, StepOutcome, TabInfo, BlockedNavigation } from "./provider";

export interface HttpProviderDeps {
  fetchFn?: typeof fetch;
  /** SSRF guard: resolves to the URL to fetch or throws. */
  checkUrl: (url: string) => Promise<string>;
  userAgent?: string;
  /** Web Bot Auth signer (null/undefined = unsigned). Each hop is signed for its own host. */
  signer?: Signer | null;
}

const MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;

export class HttpBrowserProvider implements BrowserProvider {
  readonly id = "server-http" as const;
  constructor(private readonly deps: HttpProviderDeps) {}

  async available() {
    return { ok: true as const };
  }

  async open(opts: OpenOptions): Promise<BrowserSession> {
    return new HttpSession(this.deps, opts.caps);
  }
}

class HttpSession implements BrowserSession {
  readonly provider = "server-http" as const;
  private current = { url: "", html: "", title: "", status: 0 };
  private controls: ControlNode[] = [];
  /** What was typed, per form (keyed by the form's node), until the next page load. */
  private typed = new Map<unknown, Map<string, string>>();
  private closed = false;

  constructor(
    private readonly deps: HttpProviderDeps,
    private readonly caps: TaskCapabilities,
  ) {}

  url(): string {
    return this.current.url;
  }

  allowOrigin(origin: string): void {
    grantOrigin(this.caps, origin);
  }

  async html(): Promise<string> {
    return this.current.html;
  }

  async tabs(): Promise<TabInfo[]> {
    return [{ id: "t1", url: this.current.url, title: this.current.title, active: true }];
  }

  async screenshot(): Promise<ScreenshotResult> {
    return { unavailable: "The HTTP provider reads pages without rendering them, so it cannot take a screenshot." };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async snapshot(): Promise<PageSnapshot> {
    return { url: this.current.url, title: this.current.title, controls: this.controls.map((c) => c.info) };
  }

  private blocked(url: string, reason: BlockedNavigation["reason"]): StepOutcome {
    let origin: string | null = null;
    try {
      origin = new URL(url).origin;
    } catch {
      /* not a URL */
    }
    return { url: this.current.url, navigated: false, blocked: { url, origin, reason } };
  }

  /** Fetch with manual redirects; every hop is checked before it is requested. */
  private async load(startUrl: string, init: { method: string; body?: string } = { method: "GET" }): Promise<(StepOutcome & { title: string; status: number }) | (StepOutcome & { title: string; status: number; blocked: BlockedNavigation })> {
    if (this.closed) throw new Error("This browser session is closed.");
    const fetchFn = this.deps.fetchFn ?? fetch;
    let url = startUrl;
    let method = init.method;
    let body = init.body;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const nav = checkNavigation(this.caps, url);
      if (!nav.ok) {
        const b = this.blocked(url, nav.reason === "new-origin" ? "new-origin" : "bad-scheme");
        return { ...b, title: this.current.title, status: 0, blocked: b.blocked! };
      }
      try {
        await this.deps.checkUrl(url);
      } catch {
        const b = this.blocked(url, "unsafe-address");
        return { ...b, title: this.current.title, status: 0, blocked: b.blocked! };
      }
      const baseHeaders = { "user-agent": this.deps.userAgent ?? "ShapesOS-Agent/1.0 (+https://shapesos.com/agents)", accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) };
      const headers = (await signedNavigationHeaders(this.deps.signer, { url, method, headers: baseHeaders })) ?? baseHeaders;
      const res = await fetchFn(url, { method, body, redirect: "manual", headers });
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        url = new URL(loc, url).toString();
        if (res.status !== 307 && res.status !== 308) {
          method = "GET";
          body = undefined;
        }
        continue;
      }
      const text = (await res.text()).slice(0, MAX_BYTES);
      const root = parseHtml(text);
      const titleNode = findAll(root, (n) => n.tag === "title")[0];
      this.current = { url, html: text, title: titleNode ? textOf(titleNode).trim().slice(0, 200) : "", status: res.status };
      this.controls = scanControls(text, url);
      this.typed.clear();
      const site = classifyResponse(res, text);
      return { url, navigated: true, title: this.current.title, status: res.status, ...(site.kind === "blocked_by_site" || site.kind === "payment_required" ? { siteOutcome: site } : {}) };
    }
    throw new Error("Too many redirects.");
  }

  async navigate(url: string) {
    return this.load(url);
  }

  private control(ref: string): ControlNode {
    const c = this.controls.find((x) => x.info.ref === ref);
    if (!c) throw new Error(`No control ${ref} on this page. Take a new snapshot.`);
    return c;
  }

  async type(ref: string, text: string): Promise<StepOutcome> {
    const c = this.control(ref);
    const name = attr(c.node, "name");
    if (!name) throw new Error(`Control ${ref} has no name to submit under.`);
    const form = this.typed.get(c.formNode) ?? new Map<string, string>();
    form.set(name, text);
    this.typed.set(c.formNode, form);
    return { url: this.current.url, navigated: false };
  }

  async click(ref: string): Promise<StepOutcome> {
    const c = this.control(ref);
    if (c.info.role === "link" && c.info.href) return this.load(c.info.href);
    if (c.info.role === "button" && c.formNode && c.info.form) {
      const values = formDefaults(c.formNode);
      for (const [k, v] of this.typed.get(c.formNode) ?? []) values[k] = v;
      const submitName = attr(c.node, "name");
      if (submitName) values[submitName] = attr(c.node, "value") ?? "";
      const action = c.info.form.action || this.current.url;
      const qs = new URLSearchParams(values).toString();
      if (c.info.form.method === "post") return this.load(action, { method: "POST", body: qs });
      const u = new URL(action);
      u.search = qs;
      return this.load(u.toString());
    }
    return { url: this.current.url, navigated: false };
  }
}
