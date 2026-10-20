// ShapesOS — cookie registry (beta readiness, WS=legal).
//
// Every cookie the code sets, read from the modules that set it (the unit
// test lib/legal/__tests__/cookies.test.ts checks the names against those
// modules). /cookies renders this list. All of them are strictly necessary:
// sign-in, CSRF, the active workspace, display preferences, scoped access
// tokens and a storefront cart. ShapesOS sets no analytics, advertising or
// cross-site tracking cookie, which is why there is no consent banner
// (needsConsentBanner() is false and is asserted by the test).
//
// Pure data — no I/O.

export type CookieCategory = "strictly_necessary" | "preferences" | "analytics" | "advertising";

export const COOKIE_CATEGORY_LABEL: Readonly<Record<CookieCategory, string>> = {
  strictly_necessary: "Strictly necessary",
  preferences: "Preferences",
  analytics: "Analytics",
  advertising: "Advertising",
};

export interface CookieEntry {
  /** Exact name, or a name with a placeholder in angle brackets. */
  name: string;
  /** Alternative names the same cookie takes (the __Secure- / __Host- prefix on https). */
  aliases?: readonly string[];
  category: CookieCategory;
  /** Who sets it and when. */
  setBy: string;
  purpose: string;
  lifetime: string;
  httpOnly: boolean;
  /** Where it is sent (path or host scope). */
  scope: string;
}

export const COOKIES: readonly CookieEntry[] = [
  {
    name: "authjs.session-token",
    aliases: ["__Secure-authjs.session-token"],
    category: "strictly_necessary",
    setBy: "Auth.js on sign-in (auth.ts).",
    purpose: "Your sign-in session: a signed JWT naming your user id and session id. Without it nothing behind sign-in works.",
    lifetime: "12 hours (session.maxAge), then you sign in again.",
    httpOnly: true,
    scope: "Whole site, SameSite=Lax, Secure on https.",
  },
  {
    name: "authjs.csrf-token",
    aliases: ["__Host-authjs.csrf-token"],
    category: "strictly_necessary",
    setBy: "Auth.js when a sign-in form loads.",
    purpose: "Cross-site request forgery protection for the sign-in and sign-out forms (double-submit token).",
    lifetime: "Browser session.",
    httpOnly: true,
    scope: "Whole site, SameSite=Lax.",
  },
  {
    name: "authjs.callback-url",
    aliases: ["__Secure-authjs.callback-url"],
    category: "strictly_necessary",
    setBy: "Auth.js when a sign-in starts.",
    purpose: "Where to send you after signing in (same-origin only; lib/auth/redirect.ts safeNext).",
    lifetime: "Browser session.",
    httpOnly: true,
    scope: "Whole site, SameSite=Lax.",
  },
  {
    name: "authjs.pkce.code_verifier, authjs.state, authjs.nonce",
    aliases: ["__Secure-authjs.pkce.code_verifier", "__Secure-authjs.state", "__Secure-authjs.nonce"],
    category: "strictly_necessary",
    setBy: "Auth.js only while a Google or SSO sign-in is in flight.",
    purpose: "Binds the OAuth / OIDC round trip to this browser (PKCE verifier, state and nonce).",
    lifetime: "15 minutes.",
    httpOnly: true,
    scope: "Whole site, SameSite=Lax.",
  },
  {
    name: "marketr_active_workspace",
    category: "strictly_necessary",
    setBy: "The app when you create or switch a workspace (app/api/workspaces).",
    purpose: "Which of your workspaces the app opens. Holds a workspace id only.",
    lifetime: "1 year.",
    httpOnly: true,
    scope: "Whole site, SameSite=Lax, Secure in production.",
  },
  {
    name: "shapes_shell",
    category: "strictly_necessary",
    setBy: "The app when you change a display preference (app/api/preferences).",
    purpose: "Theme, contrast, density, motion, text size and language, so the first paint is already right. Short codes only (t=dark;c=high;…), no personal data.",
    lifetime: "1 year.",
    httpOnly: true,
    scope: "Whole site, SameSite=Lax, Secure in production.",
  },
  {
    name: "shapes_portal",
    category: "strictly_necessary",
    setBy: "The client portal on portal sign-in (lib/portal).",
    purpose: "A client's portal session (never a workspace session).",
    lifetime: "7 days.",
    httpOnly: true,
    scope: "/portal and /api/portal only, SameSite=Lax, Secure on https.",
  },
  {
    name: "shapes_preview",
    category: "strictly_necessary",
    setBy: "The app when you open a sandbox preview of an agent run (lib/sandbox/preview.ts).",
    purpose: "Lets that one run's preview load its own assets cross-site; an HMAC over (run, user, workspace, expiry). Opens nothing else.",
    lifetime: "1 hour.",
    httpOnly: true,
    scope: "That run's preview path only, SameSite=None, Secure.",
  },
  {
    name: "fdr_viewer",
    category: "strictly_necessary",
    setBy: "A funding data room when a viewer verifies their email (app/r/funding).",
    purpose: "The verified viewer's session for that one data-room link.",
    lifetime: "12 hours.",
    httpOnly: true,
    scope: "That data room's path only, SameSite=Lax, Secure on https.",
  },
  {
    name: "shapes_cart_<store id>",
    category: "strictly_necessary",
    setBy: "A ShapesOS-hosted storefront when a shopper adds to the cart (lib/ops/store).",
    purpose: "The shopper's cart lines and promo code for that store, signed so it cannot be tampered with.",
    lifetime: "30 days.",
    httpOnly: true,
    scope: "Whole site, SameSite=Lax, Secure in production.",
  },
  {
    name: "payload-token",
    category: "strictly_necessary",
    setBy: "The CMS admin (/admin, Payload CMS) when a platform operator signs in there.",
    purpose: "The CMS admin session. Only operators use the CMS admin.",
    lifetime: "Payload's default (7 days).",
    httpOnly: true,
    scope: "Whole site.",
  },
];

/**
 * Not cookies, listed for honesty: browser storage the app uses on your own
 * device (never sent to us by itself, never used for tracking).
 */
export const BROWSER_STORAGE_NOTES: readonly string[] = [
  "localStorage and IndexedDB hold per-device conveniences: unsent drafts, the offline action queue, collapsed panels and the command-bar history.",
  "A service worker (public/sw.js) caches the app shell so it loads offline; it stores no personal data of its own.",
  "The experiment preview cookie (mk_exp_<id>) shown in the Test Lab is a snippet for YOUR site; ShapesOS does not set it on its own domain.",
];

/** Third-party widgets that may set cookies on their own domains, and when. */
export const THIRD_PARTY_COOKIE_NOTES: readonly string[] = [
  "Cloudflare Turnstile or hCaptcha run on the sign-in page only after repeated failed passwords, when the operator configured a CAPTCHA provider; they may set cookies on their own domains.",
  "Stripe Checkout runs on stripe.com; Stripe's own cookies apply there, not here.",
  "A workspace's optional Chatwoot widget is off unless its operator turns it on; Umami analytics on shared pages is cookieless.",
];

export function cookieEntryFor(name: string): CookieEntry | null {
  return COOKIES.find((c) => c.name === name || c.name.split(", ").includes(name) || c.aliases?.includes(name)) ?? null;
}

/** True only if a non-essential cookie exists — then a consent UI would be needed. */
export function needsConsentBanner(): boolean {
  return COOKIES.some((c) => c.category !== "strictly_necessary");
}
