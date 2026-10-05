// ShapesOS — Phase 10 (portal): pure rules — tokens (format, hashing,
// expiry), the session cookie, CSRF, viewerRole capabilities, scoping, quote
// decisions, the portal sign-in mail and the rate-limit tier. No DB.
// Run: npx tsx --test lib/portal/__tests__/portal-core.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  PORTAL_COOKIE,
  PORTAL_LINK_TTL_MS,
  PORTAL_SESSION_TTL_MS,
  checkPortalCsrf,
  cleanLinkIds,
  hashPortalToken,
  mintPortalToken,
  parsePortalToken,
  portalActorId,
  portalCan,
  portalCookieHeaders,
  portalCookieSecure,
  portalExpiry,
  portalMilestones,
  portalScope,
  portalSections,
  portalSees,
  quoteDecisionError,
  readPortalCookie,
} from "../core";
import { TOKEN_TTL_MS, looksLikeEmailToken } from "@/lib/auth/email/tokens";
import { renderAuthEmail } from "@/lib/auth/email/mail";
import { classifyTier } from "@/lib/api/rate-limit";

describe("portal tokens", () => {
  it("mint: prefix + workspace + a 43-char email-link token; only the SHA-256 is stored", () => {
    const { raw, hash } = mintPortalToken("session", "ws_abc".replace("_", "-"));
    assert.match(raw, /^ps_ws-abc_[A-Za-z0-9_-]{43}$/);
    assert.ok(looksLikeEmailToken(raw.slice(raw.length - 43)));
    assert.equal(hash, createHash("sha256").update(raw, "utf8").digest("hex"));
    assert.equal(hashPortalToken(raw), hash);
    assert.notEqual(mintPortalToken("session", "ws-abc").raw, raw, "random every time");
    assert.match(mintPortalToken("link", "cmabc123").raw, /^pl_cmabc123_/);
  });

  it("parse: names the workspace (scope only), and the kinds never mix", () => {
    const link = mintPortalToken("link", "cm1workspace").raw;
    const session = mintPortalToken("session", "cm1workspace").raw;
    assert.deepEqual(parsePortalToken(link, "link"), { workspaceId: "cm1workspace" });
    assert.deepEqual(parsePortalToken(session, "session"), { workspaceId: "cm1workspace" });
    assert.equal(parsePortalToken(link, "session"), null, "a sign-in link is not a session");
    assert.equal(parsePortalToken(session, "link"), null, "a session is not a sign-in link");
  });

  it("parse: rejects malformed tokens (and anything that could be a workspace session)", () => {
    const good = mintPortalToken("session", "ws1").raw;
    for (const bad of [
      undefined,
      null,
      42,
      "",
      good.slice(0, -1),
      `${good}x`,
      good.replace("ps_", "px_"),
      "ps_ws_1_" + "a".repeat(43), // underscore in the workspace part
      "ps__" + "a".repeat(43),
      `ps_${"w".repeat(121)}_${"a".repeat(43)}`,
      "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..abc.def.ghi", // an Auth.js JWE shape
    ]) {
      assert.equal(parsePortalToken(bad, "session"), null, String(bad));
    }
    assert.throws(() => mintPortalToken("session", "bad_id"), /Unsupported workspace id/);
  });

  it("expiry: links 15 minutes (same as a workspace magic link), sessions 7 days", () => {
    const now = new Date("2026-10-04T12:00:00Z");
    assert.equal(PORTAL_LINK_TTL_MS, TOKEN_TTL_MS.login);
    assert.equal(portalExpiry("link", now).toISOString(), "2026-10-04T12:15:00.000Z");
    assert.equal(portalExpiry("session", now).getTime() - now.getTime(), PORTAL_SESSION_TTL_MS);
    assert.equal(PORTAL_SESSION_TTL_MS, 7 * 86_400_000);
  });

  it("actor id for audit rows", () => {
    assert.equal(portalActorId("cl_1"), "client:cl_1");
  });
});

describe("portal cookie", () => {
  it("is set twice: Path=/portal and Path=/api/portal, httpOnly, SameSite=Lax — never Path=/", () => {
    const [pages, api] = portalCookieHeaders("ps_ws1_tok", { secure: true, maxAgeSec: 60 });
    assert.equal(pages, `${PORTAL_COOKIE}=ps_ws1_tok; Path=/portal; HttpOnly; SameSite=Lax; Secure; Max-Age=60`);
    assert.equal(api, `${PORTAL_COOKIE}=ps_ws1_tok; Path=/api/portal; HttpOnly; SameSite=Lax; Secure; Max-Age=60`);
    for (const c of portalCookieHeaders("v", { secure: false })) {
      assert.doesNotMatch(c, /Path=\/(;|$)/);
      assert.doesNotMatch(c, /Secure/);
      assert.match(c, /Max-Age=604800$/);
    }
    for (const c of portalCookieHeaders(null, { secure: true })) assert.match(c, /^shapes_portal=; .*Max-Age=0$/);
  });

  it("reads only a well-formed session token from the Cookie header", () => {
    const t = mintPortalToken("session", "ws1").raw;
    assert.equal(readPortalCookie(`a=1; ${PORTAL_COOKIE}=${t}; b=2`), t);
    assert.equal(readPortalCookie(`authjs.session-token=${t}`), null, "the portal token under another name is ignored");
    assert.equal(readPortalCookie(`${PORTAL_COOKIE}=garbage`), null);
    assert.equal(readPortalCookie(`${PORTAL_COOKIE}=${mintPortalToken("link", "ws1").raw}`), null, "a sign-in link is not a session");
    assert.equal(readPortalCookie(null), null);
  });

  it("secure on https and always in production", () => {
    assert.equal(portalCookieSecure("https://app.test/api/portal/link", {} as NodeJS.ProcessEnv), true);
    assert.equal(portalCookieSecure("http://localhost:3000/api/portal/link", {} as NodeJS.ProcessEnv), false);
    assert.equal(portalCookieSecure("http://internal:3000/x", { NODE_ENV: "production" } as NodeJS.ProcessEnv), true);
  });
});

describe("portal CSRF", () => {
  const req = (method: string, headers: Record<string, string>) => ({ method, url: "http://app.test/api/portal/tickets", headers: new Headers(headers) });

  it("reads pass; writes need JSON + a same-origin Origin", () => {
    assert.deepEqual(checkPortalCsrf(req("GET", {})), { ok: true });
    assert.deepEqual(checkPortalCsrf(req("POST", { "content-type": "application/json", origin: "http://app.test" })), { ok: true });
    assert.deepEqual(
      checkPortalCsrf(req("POST", { "content-type": "application/json; charset=utf-8", origin: "https://portal.example" }), ["https://portal.example/"]),
      { ok: true },
      "the configured base URL counts as same-origin",
    );
  });

  it("refuses forms, missing or foreign Origin, and cross-site fetches", () => {
    const refused = [
      req("POST", { "content-type": "application/x-www-form-urlencoded", origin: "http://app.test" }),
      req("POST", { "content-type": "text/plain", origin: "http://app.test" }),
      req("POST", { "content-type": "application/json" }),
      req("POST", { "content-type": "application/json", origin: "https://evil.test" }),
      req("POST", { "content-type": "application/json", origin: "null" }),
      req("POST", { "content-type": "application/json", origin: "http://app.test", "sec-fetch-site": "cross-site" }),
      req("DELETE", { origin: "http://app.test" }),
    ];
    for (const r of refused) assert.equal(checkPortalCsrf(r).ok, false, JSON.stringify([...r.headers]));
  });
});

describe("viewerRole capabilities", () => {
  it("viewer: projects, tickets, documents — read-only", () => {
    assert.deepEqual(portalSections("viewer"), ["projects", "tickets", "documents"]);
    assert.equal(portalSees("viewer", "invoices"), false);
    assert.equal(portalSees("viewer", "quotes"), false);
    for (const a of ["ticket_write", "invoice_pay", "quote_decide"] as const) assert.equal(portalCan("viewer", a), false, a);
  });

  it("editor: + invoices and quotes, tickets and paying; admin: + quote decisions", () => {
    assert.deepEqual(portalSections("editor"), ["projects", "invoices", "quotes", "tickets", "documents"]);
    assert.equal(portalCan("editor", "ticket_write"), true);
    assert.equal(portalCan("editor", "invoice_pay"), true);
    assert.equal(portalCan("editor", "quote_decide"), false);
    assert.equal(portalCan("admin", "quote_decide"), true);
  });

  it("unknown roles fall back to viewer (fail closed)", () => {
    assert.equal(portalCan("owner", "quote_decide"), false);
    assert.equal(portalSees(undefined, "invoices"), false);
  });
});

describe("portal scope", () => {
  const contacts = [
    { id: "c1", leadId: "l1", companyId: null, email: "Ana@Acme.test" },
    { id: "c2", leadId: null, companyId: "co1", email: "bo@acme.test" },
    { id: "c3", leadId: "l3", companyId: "co1", email: null },
    { id: "c9", leadId: "l9", companyId: "co9", email: "x@other.test" },
  ];

  it("nothing linked → sees nothing", () => {
    const s = portalScope({ portalCompanyIds: [], portalContactIds: [], portalLeadIds: [] }, contacts, "me@client.test");
    assert.deepEqual([s.contactIds, s.leadIds, s.companyIds], [[], [], []]);
    assert.deepEqual(s.emails, ["me@client.test"]);
  });

  it("contacts → tickets; contacts' source leads + explicit leads → invoices/quotes/projects", () => {
    const s = portalScope({ portalCompanyIds: ["co1"], portalContactIds: ["c1"], portalLeadIds: ["l7", "l1"] }, contacts, "Me@Client.test");
    assert.deepEqual(s.contactIds, ["c1", "c2", "c3"]);
    assert.deepEqual(s.leadIds, ["l7", "l1", "l3"]);
    assert.deepEqual(s.emails, ["me@client.test", "ana@acme.test", "bo@acme.test"]);
    assert.ok(!s.contactIds.includes("c9"), "a contact loaded but not linked is never in scope");
  });

  it("cleanLinkIds dedupes, trims, caps", () => {
    assert.deepEqual(cleanLinkIds([" a ", "a", "", 3, "b"], "contacts"), ["a", "b"]);
    assert.throws(() => cleanLinkIds("a", "contacts"), /list of ids/);
    assert.throws(() => cleanLinkIds(Array.from({ length: 101 }, (_, i) => `id${i}`), "contacts"), /at most 100/);
    assert.throws(() => cleanLinkIds(["x".repeat(65)], "leads"), /64 characters/);
  });
});

describe("quote decisions + milestones", () => {
  const now = new Date("2026-10-04T12:00:00Z");
  it("only a sent, unexpired quote can be decided", () => {
    assert.equal(quoteDecisionError({ status: "sent", validUntil: null }, now), null);
    assert.equal(quoteDecisionError({ status: "sent", validUntil: new Date("2026-10-05T00:00:00Z") }, now), null);
    assert.match(quoteDecisionError({ status: "sent", validUntil: new Date("2026-10-01T00:00:00Z") }, now)!, /expired/);
    assert.match(quoteDecisionError({ status: "accepted", validUntil: null }, now)!, /already accepted/);
    assert.match(quoteDecisionError({ status: "draft", validUntil: null }, now)!, /already draft/);
  });

  it("milestones are sanitized from the stored JSON", () => {
    assert.deepEqual(portalMilestones(null), []);
    assert.deepEqual(portalMilestones([{ title: "Kickoff", dueAt: "2026-10-10", status: "done", secret: 1 }, { title: "" }, "junk", { title: "Launch" }]), [
      { title: "Kickoff", dueAt: "2026-10-10", status: "done" },
      { title: "Launch", dueAt: null, status: "pending" },
    ]);
  });
});

describe("portal sign-in mail + rate tier", () => {
  it("the portal mail names the workspace, keeps the link, and never echoes control characters", () => {
    const m = renderAuthEmail({ kind: "portal", to: "a@b.test", url: "https://app.test/portal/link#token=pl_x", detail: "Acme\nAgency" });
    assert.equal(m.subject, "Your client portal sign-in link");
    assert.match(m.text, /Shared with you by Acme Agency\./);
    assert.match(m.text, /https:\/\/app\.test\/portal\/link#token=pl_x/);
    assert.match(m.text, /expires in 15 minutes/);
    assert.doesNotMatch(renderAuthEmail({ kind: "login", to: "a@b.test", url: "u" }).text, /Shared with you/);
  });

  it("portal sign-in routes are on the auth tier; the rest of /api/portal on read/write", () => {
    assert.equal(classifyTier("/api/portal/login", "POST"), "auth");
    assert.equal(classifyTier("/api/portal/link", "POST"), "auth");
    assert.equal(classifyTier("/api/portal/tickets", "POST"), "write");
    assert.equal(classifyTier("/api/portal/invoices/x/pdf", "GET"), "read");
  });
});
