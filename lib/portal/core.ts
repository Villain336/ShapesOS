// ShapesOS — Phase 10 (portal): pure rules for the client portal.
//
// The portal is a SEPARATE credential from the workspace session:
//   - Sign-in reuses the Phase 6 email-link primitives (lib/auth/email/
//     tokens.ts): 32 random bytes, base64url, only the SHA-256 is stored,
//     15-minute single-use links, the per-address send limit.
//   - Raw tokens look like  pl_<workspaceId>_<43 chars>  (sign-in link) and
//     ps_<workspaceId>_<43 chars>  (session). The workspace id is NOT
//     trusted on its own: it only picks the RLS scope (app.workspace_id) the
//     hash lookup runs in — a hash minted for workspace A never exists in B's
//     scope (the SCIM token pattern, lib/scim/auth.ts).
//   - The session rides in its own httpOnly cookie, set twice: Path=/portal
//     (pages) and Path=/api/portal (portal API). Browsers never send it to
//     /dashboard or any other /api route, and nothing outside lib/portal reads
//     it — requireUser()/auth() only know the Auth.js cookie.
//
// Nothing here touches the database.

import { generateEmailToken, hashEmailToken, TOKEN_TTL_MS } from "@/lib/auth/email/tokens";

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export type PortalTokenKind = "link" | "session";

const PREFIX: Record<PortalTokenKind, string> = { link: "pl_", session: "ps_" };
const WORKSPACE_ID = /^[A-Za-z0-9-]{1,120}$/;
const TOKEN_RE: Record<PortalTokenKind, RegExp> = {
  link: /^pl_([A-Za-z0-9-]{1,120})_([A-Za-z0-9_-]{43})$/,
  session: /^ps_([A-Za-z0-9-]{1,120})_([A-Za-z0-9_-]{43})$/,
};

/** Sign-in links live as long as a workspace magic link (15 minutes). */
export const PORTAL_LINK_TTL_MS = TOKEN_TTL_MS.login;
/** A portal session lasts 7 days (absolute), unless signed out or revoked. */
export const PORTAL_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** At most this many client records (workspaces) get a link per request. */
export const PORTAL_MAX_CLIENTS_PER_EMAIL = 5;
/** lastSeenAt is written at most this often per session. */
export const PORTAL_SEEN_RESOLUTION_MS = 5 * 60 * 1000;

export function mintPortalToken(kind: PortalTokenKind, workspaceId: string): { raw: string; hash: string } {
  if (!WORKSPACE_ID.test(workspaceId)) throw new Error("Unsupported workspace id for a portal token");
  const raw = `${PREFIX[kind]}${workspaceId}_${generateEmailToken()}`;
  return { raw, hash: hashPortalToken(raw) };
}

/** The workspace a well-formed token names (unverified), or null. */
export function parsePortalToken(raw: unknown, kind: PortalTokenKind): { workspaceId: string } | null {
  if (typeof raw !== "string" || raw.length > 200) return null;
  const m = TOKEN_RE[kind].exec(raw);
  return m ? { workspaceId: m[1]! } : null;
}

/** SHA-256 hex of the whole raw token (prefix + workspace + random part). */
export function hashPortalToken(raw: string): string {
  return hashEmailToken(raw);
}

export function portalExpiry(kind: PortalTokenKind, now: Date = new Date()): Date {
  return new Date(now.getTime() + (kind === "link" ? PORTAL_LINK_TTL_MS : PORTAL_SESSION_TTL_MS));
}

/** Who did it, in ops audit rows and helpdesk messages: "client:<id>". */
export function portalActorId(clientId: string): string {
  return `client:${clientId}`;
}

// ---------------------------------------------------------------------------
// Cookie
// ---------------------------------------------------------------------------

export const PORTAL_COOKIE = "shapes_portal";
export const PORTAL_COOKIE_PATHS = ["/portal", "/api/portal"] as const;

/** Set-Cookie values for a new session (one per path), or to clear it (value null). */
export function portalCookieHeaders(value: string | null, opts: { secure: boolean; maxAgeSec?: number }): string[] {
  return PORTAL_COOKIE_PATHS.map((path) =>
    [
      `${PORTAL_COOKIE}=${value ?? ""}`,
      `Path=${path}`,
      "HttpOnly",
      "SameSite=Lax",
      ...(opts.secure ? ["Secure"] : []),
      value === null ? "Max-Age=0" : `Max-Age=${Math.max(0, Math.floor(opts.maxAgeSec ?? PORTAL_SESSION_TTL_MS / 1000))}`,
    ].join("; "),
  );
}

/** The portal session token from a Cookie header, or null. */
export function readPortalCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== PORTAL_COOKIE) continue;
    const v = part.slice(i + 1).trim();
    if (parsePortalToken(v, "session")) return v;
  }
  return null;
}

/** Secure cookies on https deployments (and always in production). */
export function portalCookieSecure(reqUrl: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === "production") return true;
  try {
    return new URL(reqUrl).protocol === "https:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// CSRF: portal writes are JSON-only, same-origin requests
// ---------------------------------------------------------------------------

export type CsrfVerdict = { ok: true } | { ok: false; reason: string };

/**
 * A portal write must (1) be application/json — a cross-site HTML form
 * can't send that without a CORS preflight, which /api/portal never grants —
 * (2) carry an Origin header naming this app (the request's own origin or
 * the configured base URL), and (3) not be marked cross-site by the browser
 * (Sec-Fetch-Site). The SameSite=Lax cookie is the third layer.
 */
export function checkPortalCsrf(
  req: { method: string; url: string; headers: Headers },
  allowedOrigins: Array<string | null | undefined> = [],
): CsrfVerdict {
  const m = req.method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return { ok: true };
  const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return { ok: false, reason: "Send the request as application/json." };
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return { ok: false, reason: "Cross-site request refused." };
  const origin = req.headers.get("origin");
  if (!origin) return { ok: false, reason: "Missing Origin header." };
  const allowed = new Set<string>();
  for (const o of [req.url, ...allowedOrigins]) {
    if (!o) continue;
    try {
      allowed.add(new URL(o).origin);
    } catch {
      /* ignore malformed config */
    }
  }
  return allowed.has(origin) ? { ok: true } : { ok: false, reason: "Cross-site request refused." };
}

// ---------------------------------------------------------------------------
// What a client sees and may do (Client.viewerRole)
// ---------------------------------------------------------------------------

export type PortalRole = "viewer" | "editor" | "admin";
export type PortalSection = "invoices" | "quotes" | "projects" | "tickets" | "documents";
export type PortalAction = "ticket_write" | "invoice_pay" | "quote_decide";

export const PORTAL_SECTION_ORDER: PortalSection[] = ["projects", "invoices", "quotes", "tickets", "documents"];

/**
 * viewer ("Can view")    projects, tickets and documents, read-only
 * editor ("Can edit")    + invoices and quotes, open and reply to tickets, pay invoices
 * admin  ("Full access") + accept or decline quotes
 */
const SECTIONS: Record<PortalRole, PortalSection[]> = {
  viewer: ["projects", "tickets", "documents"],
  editor: ["projects", "invoices", "quotes", "tickets", "documents"],
  admin: ["projects", "invoices", "quotes", "tickets", "documents"],
};
const ACTIONS: Record<PortalRole, PortalAction[]> = {
  viewer: [],
  editor: ["ticket_write", "invoice_pay"],
  admin: ["ticket_write", "invoice_pay", "quote_decide"],
};

function role(r: unknown): PortalRole {
  return r === "admin" || r === "editor" ? r : "viewer";
}

export function portalSees(r: unknown, section: PortalSection): boolean {
  return SECTIONS[role(r)].includes(section);
}

export function portalCan(r: unknown, action: PortalAction): boolean {
  return ACTIONS[role(r)].includes(action);
}

export function portalSections(r: unknown): PortalSection[] {
  return PORTAL_SECTION_ORDER.filter((s) => portalSees(r, s));
}

// ---------------------------------------------------------------------------
// Scope: which CRM records a client is linked to
// ---------------------------------------------------------------------------

export const PORTAL_MAX_LINKS = 100;

export interface PortalLinks {
  portalCompanyIds: string[] | null;
  portalContactIds: string[] | null;
  portalLeadIds: string[] | null;
}

export interface PortalScope {
  companyIds: string[];
  contactIds: string[];
  /** crm_leads ids: the customer on invoices, quotes and projects. */
  leadIds: string[];
  /** Addresses that identify this client (sign-in email + linked contacts). */
  emails: string[];
}

const uniq = (xs: Array<string | null | undefined>) => [...new Set(xs.filter((x): x is string => typeof x === "string" && x.length > 0))];

/**
 * Combine the client's explicit links with the contacts they reach (linked
 * contacts + contacts of linked companies, already loaded workspace-scoped):
 * contacts → tickets; leads (explicit + each contact's source lead) →
 * invoices, quotes, projects. Nothing linked → an empty scope (sees nothing).
 */
export function portalScope(
  links: PortalLinks,
  reachedContacts: Array<{ id: string; leadId: string | null; companyId: string | null; email: string | null }>,
  loginEmail: string,
): PortalScope {
  const companyIds = uniq(links.portalCompanyIds ?? []);
  const linkedContacts = new Set(uniq(links.portalContactIds ?? []));
  const company = new Set(companyIds);
  const contacts = reachedContacts.filter((c) => linkedContacts.has(c.id) || (c.companyId !== null && company.has(c.companyId)));
  return {
    companyIds,
    contactIds: uniq(contacts.map((c) => c.id)),
    leadIds: uniq([...(links.portalLeadIds ?? []), ...contacts.map((c) => c.leadId)]),
    emails: uniq([loginEmail.toLowerCase(), ...contacts.map((c) => c.email?.toLowerCase())]),
  };
}

/** Validate an admin's link list: unique non-empty ids, at most PORTAL_MAX_LINKS. */
export function cleanLinkIds(raw: unknown, what: string): string[] {
  if (!Array.isArray(raw)) throw new Error(`${what} must be a list of ids`);
  const ids = uniq(raw.map((x) => (typeof x === "string" ? x.trim() : "")));
  if (ids.some((x) => x.length > 64)) throw new Error(`${what}: ids are at most 64 characters`);
  if (ids.length > PORTAL_MAX_LINKS) throw new Error(`Link at most ${PORTAL_MAX_LINKS} ${what}`);
  return ids;
}

// ---------------------------------------------------------------------------
// What the client may see of each record
// ---------------------------------------------------------------------------

/** Invoices/credit notes the client may see: issued ones only (never drafts). */
export const PORTAL_INVOICE_STATUSES = ["sent", "overdue", "paid", "cancelled"] as const;
/** Quotes the client may see: sent or decided (never drafts). */
export const PORTAL_QUOTE_STATUSES = ["sent", "accepted", "declined", "expired"] as const;
/** Ticket messages a client sees: their own and the team's replies, never internal notes. */
export const PORTAL_MESSAGE_DIRECTIONS = ["inbound", "outbound"] as const;

export type QuoteDecision = "accept" | "decline";

/** Can a sent quote still be decided? (expired by date → no). */
export function quoteDecisionError(q: { status: string; validUntil: Date | null }, now: Date = new Date()): string | null {
  if (q.status !== "sent") return `This quote is already ${q.status}.`;
  if (q.validUntil && q.validUntil.getTime() < now.getTime()) return "This quote has expired. Ask for a new one.";
  return null;
}

/** A milestone as stored on OpsProject.milestones (JSON), sanitized for the client. */
export function portalMilestones(raw: unknown): Array<{ title: string; dueAt: string | null; status: string }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
    .map((m) => ({
      title: String(m.title ?? "").slice(0, 300),
      dueAt: typeof m.dueAt === "string" ? m.dueAt : null,
      status: typeof m.status === "string" ? m.status : "pending",
    }))
    .filter((m) => m.title)
    .slice(0, 100);
}
