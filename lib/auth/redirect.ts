// Marketr — safe post-login redirect target (day-1 hardening).
//
// The /invite flow redirects unauthenticated recipients to
// /login?next=<encoded invite URL> so they land back on their invite after
// signing in. safeNext is the open-redirect guard: only a plain same-origin
// path is honored; anything else (absolute URLs, protocol-relative,
// backslashes) falls back to /dashboard.

export function safeNext(value: string | null): string {
  if (
    value &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\")
  )
    return value;
  return "/dashboard";
}
