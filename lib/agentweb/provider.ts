// ShapesOS — Phase 21A (WS=agentweb): the BrowserProvider seam.
//
// One interface for "a browser an agent can drive", with the same tools on top
// (browser_snapshot, browser_navigate, browser_click, browser_type,
// browser_tabs, browser_screenshot, browser_extract). Implementations:
//
//   server       Playwright Chromium on the server (provider-server.ts). A
//                fresh agent profile, no user logins, every request through the
//                SSRF guard, document navigations fenced to the task's origins.
//   server-http  no JavaScript: fetch + parse (provider-http.ts). The cheap path
//                for static pages; the evals and unit tests run on it.
//   desktop-tab  A LIVE tab in the user's ShapesOS Desktop browser, driven over
//                the Chrome DevTools protocol on its webContents. NOT in this
//                round: it lands with the Desktop browser shell (M1, the 19A
//                desktop branch). The seam is here: implement BrowserProvider,
//                call registerBrowserProvider("desktop-tab", factory). Until
//                then getBrowserProvider("desktop-tab") says so, honestly.
//
// A provider performs steps. It never decides whether a step is allowed: that
// is the safety kernel's job (kernel.ts), called by the tools BEFORE a provider
// is asked to act. What a provider does enforce is the origin fence on document
// navigations, because a redirect happens inside the browser, after the tool
// has already checked the URL it was given.

import type { TaskCapabilities } from "./capabilities";
import type { ElementInfo } from "./types";

export type ProviderId = "server" | "server-http" | "desktop-tab";

export interface PageSnapshot {
  url: string;
  title: string;
  /** The page's controls with refs valid until the next snapshot or navigation. */
  controls: ElementInfo[];
}

/** A navigation the provider refused because it left the task's origins (or the SSRF guard said no). */
export interface BlockedNavigation {
  url: string;
  origin: string | null;
  reason: "new-origin" | "unsafe-address" | "bad-scheme";
}

import type { FetchOutcome } from "./identity/agent-fetch";

export interface StepOutcome {
  url: string;
  /** The site's answer when it refused the agent or wants payment (never worked around). */
  siteOutcome?: Exclude<FetchOutcome, { kind: "ok" } | { kind: "error" }>;
  /** The step changed the page address. */
  navigated: boolean;
  /** Set when the step tried to move off the task's origins; the page content was NOT loaded. */
  blocked?: BlockedNavigation;
}

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export type ScreenshotResult = { png: Buffer } | { unavailable: string };

export interface BrowserSession {
  readonly provider: ProviderId;
  url(): string;
  navigate(url: string): Promise<StepOutcome & { title: string; status: number }>;
  snapshot(): Promise<PageSnapshot>;
  /** The page source, for the reader and for receipts. Kernel-internal: NEVER handed to the actor model. */
  html(): Promise<string>;
  click(ref: string): Promise<StepOutcome>;
  /** The text typed is never kept by the provider beyond the step. */
  type(ref: string, text: string): Promise<StepOutcome>;
  screenshot(): Promise<ScreenshotResult>;
  tabs(): Promise<TabInfo[]>;
  /** The person allowed another origin for the rest of the task. */
  allowOrigin(origin: string): void;
  close(): Promise<void>;
}

export interface OpenOptions {
  caps: TaskCapabilities;
  signal?: AbortSignal;
}

export interface BrowserProvider {
  readonly id: ProviderId;
  /** Can this provider run here? (a browser binary, a connected Desktop). */
  available(): Promise<{ ok: true } | { ok: false; reason: string }>;
  open(opts: OpenOptions): Promise<BrowserSession>;
}

// ---- registry --------------------------------------------------------------

const factories = new Map<ProviderId, () => BrowserProvider>();

export function registerBrowserProvider(id: ProviderId, factory: () => BrowserProvider): void {
  factories.set(id, factory);
}

export class ProviderUnavailableError extends Error {
  constructor(id: ProviderId, reason: string) {
    super(`The ${id} browser provider is not available: ${reason}`);
    this.name = "ProviderUnavailableError";
  }
}

export function getBrowserProvider(id: ProviderId = "server"): BrowserProvider {
  const f = factories.get(id);
  if (!f) {
    throw new ProviderUnavailableError(id, id === "desktop-tab" ? "live tabs arrive with the Desktop browser (not in this release)" : "it is not registered");
  }
  return f();
}
