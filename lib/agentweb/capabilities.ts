// ShapesOS — Phase 21A (WS=agentweb): origin-scoped task capabilities (PURE).
//
// A browsing task is given its origins and action classes up front. A page
// that redirects, or a model that proposes a new address, does not widen
// them: a step onto another origin pauses and asks the person. Origins are
// compared exactly (scheme + host + port): a subdomain or http:// twin is a
// different origin on purpose.

/** read: look at pages. interact: click and type on them. send / post / file_write: outward effects, always asked. */
export type ActionClass = "read" | "interact" | "send" | "post" | "file_write";

export interface TaskCapabilities {
  allowedOrigins: Set<string>;
  allowedActions: Set<ActionClass>;
}

export type NavigationCheck = { ok: true } | { ok: false; reason: "new-origin"; origin: string } | { ok: false; reason: "bad-scheme" } | { ok: false; reason: "invalid" };

export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

export function capabilitiesFor(startUrl: string, extra: { origins?: string[]; actions?: ActionClass[] } = {}): TaskCapabilities {
  const first = originOf(startUrl);
  const origins = new Set<string>(first ? [first] : []);
  for (const o of extra.origins ?? []) {
    const n = originOf(o);
    if (n) origins.add(n);
  }
  return { allowedOrigins: origins, allowedActions: new Set<ActionClass>(["read", "interact", ...(extra.actions ?? [])]) };
}

export function checkNavigation(caps: TaskCapabilities, url: string): NavigationCheck {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "bad-scheme" };
  return caps.allowedOrigins.has(u.origin) ? { ok: true } : { ok: false, reason: "new-origin", origin: u.origin };
}

/** The person said yes to this origin for the rest of the task. */
export function grantOrigin(caps: TaskCapabilities, origin: string): void {
  const n = originOf(origin);
  if (n) caps.allowedOrigins.add(n);
}
