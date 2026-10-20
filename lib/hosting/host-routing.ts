// ShapesOS — host routing: the public website and the OS on two hostnames.
//
// shapesos.com (WEBSITE_HOST) serves the website: the landing page, /pricing,
// the legal and trust pages (/terms, /privacy, /status, …) and later /legal,
// /docs and /download. app.shapesos.com (APP_HOST) serves
// the OS: the dashboard, sign-in, the client portal, the CMS admin and the API.
// Both names point at the same web service; proxy.ts calls decideHostRoute()
// for every page request and redirects a request that arrived on the wrong
// host. Pure and exported so every case is unit-tested
// (lib/hosting/__tests__/host-routing.test.ts).
//
// Rules (only when BOTH env vars are set and differ — otherwise nothing
// changes, which is what self-host, dev, CI and the e2e suite rely on):
//   - Only GET and HEAD are redirected. A form post or server action is never
//     bounced mid-flight (it can't reach the wrong host anyway: the page that
//     posts it was already redirected on GET).
//   - Never redirected, on any host: /api/* (OAuth callbacks are registered on
//     the app host and land there directly; Render's health checks send the
//     custom domain as Host), /mcp, /cms-api, /_next/*, /.well-known/*, and
//     the public share/booking/event/shop pages (/r, /s, /book, /events,
//     /shop) — links to those were minted on whatever host was configured
//     then and must keep working.
//   - Website host + an OS path (/dashboard, /login, /signup, …) → 308 to the
//     same path and query on the app host.
//   - App host + a website path (/pricing, /legal, /docs, /download) → 308 to
//     the same path and query on the website host.
//   - App host + "/" → 307 to /dashboard on the app host (the dashboard sends
//     a signed-out visitor to /login). Temporary on purpose: "/" may become an
//     app home later, and browsers cache 308s.
//   - Any other host (tenant custom domains, domains.shapesos.com, the
//     onrender.com name, localhost) → never redirected.
//   - Any other path → served where it was asked for.

export interface HostRoutingConfig {
  /** Normalized website host, e.g. "shapesos.com" (may carry ":port"). */
  websiteHost: string;
  /** Normalized app host, e.g. "app.shapesos.com" (may carry ":port"). */
  appHost: string;
}

export type HostRouteDecision =
  | { action: "pass" }
  | { action: "redirect"; location: string; status: 307 | 308 };

export interface HostRouteRequest {
  method: string;
  /** The Host header as received. */
  host: string | null;
  pathname: string;
  /** "" or "?…" */
  search: string;
  /** X-Forwarded-Proto as received (first value wins), if any. */
  forwardedProto?: string | null;
  /** The request URL's own protocol, e.g. "https:" (fallback). */
  protocol?: string | null;
}

/** OS surfaces: on the website host they move to the app host. */
export const APP_ONLY_PATHS = [
  "/dashboard",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/invite",
  "/invite-required",
  // Beta legal pages (WS=legal): "/security" itself is now the public
  // security page (a website page below); only the two-factor setup screen
  // stays on the app host.
  "/security/setup",
  "/portal",
  "/admin",
] as const;

/** Website pages (besides "/"): on the app host they move to the website host. */
export const WEBSITE_ONLY_PATHS = [
  "/pricing",
  "/legal",
  "/docs",
  "/download",
  // Beta legal and trust pages (lib/legal/public-pages.ts LEGAL_PAGES; the
  // unit test there keeps this list and the registry in step).
  "/terms",
  "/privacy",
  "/dpa",
  "/subprocessors",
  "/security",
  "/acceptable-use",
  "/cookies",
  "/contact",
  "/status",
] as const;

/** Served on every host, never redirected. */
export const SHARED_PATHS = [
  "/api",
  "/mcp",
  "/cms-api",
  "/_next",
  "/.well-known",
  "/r",
  "/s",
  "/book",
  "/events",
  "/shop",
] as const;

const PASS: HostRouteDecision = { action: "pass" };

/** "https://App.Example.com/" → "app.example.com"; "" / invalid → null. */
export function normalizeHost(value: string | null | undefined): string | null {
  let v = (value ?? "").trim().toLowerCase();
  if (!v) return null;
  if (v.includes("://")) {
    try {
      v = new URL(v).host;
    } catch {
      return null;
    }
  }
  v = v.replace(/\/.*$/, "").replace(/\.$/, "");
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(v) || v.startsWith(".") || v.startsWith("-")) return null;
  return v;
}

/** Routing config from env, or null (routing off) unless both hosts are set and differ. */
export function hostRoutingConfig(env: {
  WEBSITE_HOST?: string | undefined;
  APP_HOST?: string | undefined;
}): HostRoutingConfig | null {
  const websiteHost = normalizeHost(env.WEBSITE_HOST);
  const appHost = normalizeHost(env.APP_HOST);
  if (!websiteHost || !appHost || websiteHost === appHost) return null;
  return { websiteHost, appHost };
}

function underAny(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Does the request's Host header name this configured host? */
function hostMatches(requestHost: string, configured: string): boolean {
  if (configured.includes(":")) return requestHost === configured;
  return requestHost.replace(/:\d+$/, "") === configured;
}

function schemeOf(req: HostRouteRequest): "http" | "https" {
  const fwd = (req.forwardedProto ?? "").split(",")[0]?.trim().toLowerCase();
  if (fwd === "https" || fwd === "http") return fwd;
  return (req.protocol ?? "").toLowerCase().startsWith("http:") ? "http" : "https";
}

export function decideHostRoute(req: HostRouteRequest, config: HostRoutingConfig | null): HostRouteDecision {
  if (!config) return PASS;
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return PASS;
  const host = normalizeHost(req.host);
  if (!host) return PASS;
  const path = req.pathname || "/";
  if (underAny(path, SHARED_PATHS)) return PASS;

  const scheme = schemeOf(req);
  const to = (targetHost: string, pathname: string, status: 307 | 308): HostRouteDecision => ({
    action: "redirect",
    location: `${scheme}://${targetHost}${pathname}${req.search ?? ""}`,
    status,
  });

  if (hostMatches(host, config.websiteHost)) {
    return underAny(path, APP_ONLY_PATHS) ? to(config.appHost, path, 308) : PASS;
  }
  if (hostMatches(host, config.appHost)) {
    // Keep the port the visitor used on the app host for the same-host hop.
    if (path === "/") return to(host, "/dashboard", 307);
    // An OS path wins over a website prefix it sits under ("/security/setup"
    // is the app's two-factor setup; "/security" is the website's page).
    if (underAny(path, APP_ONLY_PATHS)) return PASS;
    return underAny(path, WEBSITE_ONLY_PATHS) ? to(config.websiteHost, path, 308) : PASS;
  }
  return PASS;
}
