// Marketr GROUP A edge-case sweep — messaging stack (newsletter, social, ads).
// READ-ONLY on sources: pure functions + mock ports + fake Prisma clients.
// No live DB, no network. Deterministic: fixed inputs, counter-based mocks.
// Run: npx tsx scripts/edge-messaging.mts

process.env.MARKETR_CREDENTIALS_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.MARKETR_BASE_URL = "https://news.example.com/";

import {
  attr,
  checkBroadcastGuardrails,
  docHasUnsubscribe,
  docWordCount,
  ensureUnsubscribe,
  isValidEmail,
  mapSubscriberColumns,
  normalizeDoc,
  parseSubscriberCsv,
  SUBSCRIBER_CSV_CAP,
  textLines,
  unsubscribeUrlFor,
  type EmailBlockNode,
  type EmailTiptapDoc,
} from "@/lib/newsletter/blocks";
import { renderNewsletter } from "@/lib/newsletter/render";
import { MockResendPort } from "@/lib/newsletter/resend";
import {
  addDomain,
  appBaseUrl,
  cancelBroadcast,
  createList,
  getResendPort,
  handleResendWebhook,
  importSubscribers,
  refreshDomain,
  requireVerifiedDomain,
  runDueBroadcasts,
  sendBroadcast,
  setResendKey,
  testSend,
  unsubscribeByToken,
} from "@/lib/newsletter/service";
import { parseCsv } from "@/lib/seo/programmatic";
import type { PrismaClient } from "@prisma/client";

let passed = 0;
let failed = 0;
const sectionCounts: Record<string, { p: number; f: number }> = {};
let section = "";
function check(name: string, cond: boolean, detail = ""): void {
  const s = sectionCounts[section] ?? (sectionCounts[section] = { p: 0, f: 0 });
  if (cond) {
    passed += 1;
    s.p += 1;
  } else {
    failed += 1;
    s.f += 1;
    console.error(`FAIL [${section}]: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const BASE = "https://news.example.com";
function sampleDoc(): EmailTiptapDoc {
  return {
    type: "doc",
    content: [
      { type: "emailHero", attrs: { title: "Hi", subtitle: "" } },
      {
        type: "emailText",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
      },
    ],
  };
}

// ===========================================================================
// 1. newsletter/blocks.ts — normalization, email validation, CSV import
// ===========================================================================
section = "blocks";

check("normalizeDoc(null)", normalizeDoc(null).content.length === 0);
check("normalizeDoc(undefined)", normalizeDoc(undefined).content.length === 0);
check("normalizeDoc(string)", normalizeDoc("nope").content.length === 0);
check("normalizeDoc(number)", normalizeDoc(42).content.length === 0);
check("normalizeDoc(array)", normalizeDoc([]).content.length === 0);
check("normalizeDoc non-array content", normalizeDoc({ content: "nope" }).content.length === 0);
check("normalizeDoc drops case-mismatched type", normalizeDoc({ type: "doc", content: [{ type: "EmailText" }] }).content.length === 0);
{
  const d = normalizeDoc({ type: "doc", content: [{ type: "emailText", attrs: [1, 2] as unknown as Record<string, unknown> }] });
  check("normalizeDoc array attrs no-throw", d.content.length === 1);
  check("attr fallback on array attrs", attr(d.content[0], "x", "fb") === "fb");
}
{
  const d = normalizeDoc({ type: "doc", content: [{ type: "emailText", attrs: "str" as unknown as Record<string, unknown> }] });
  check("normalizeDoc string attrs coerced", d.content.length === 1 && typeof d.content[0].attrs === "object");
}
check("normalizeDoc keeps emailImage without content", normalizeDoc({ type: "doc", content: [{ type: "emailImage" }] }).content[0].content === undefined);

// unicode / emoji / RTL / huge strings
{
  const rtl = normalizeDoc({
    type: "doc",
    content: [
      {
        type: "emailText",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "مرحبا 🌍 שלום " },
              { type: "text", text: "x".repeat(100_000), marks: [{ type: "bold" }] },
            ],
          },
        ],
      },
    ],
  });
  const lines = textLines(rtl.content[0]);
  check("unicode/emoji/RTL preserved", lines[0].runs[0].text === "مرحبا 🌍 שלום ");
  check("100k char run preserved", lines[0].runs[1].text.length === 100_000 && lines[0].runs[1].bold === true);
  check("word count on mixed unicode", docWordCount(rtl) === 4, `got ${docWordCount(rtl)}`);
}
{
  const lines = textLines({ type: "emailText" });
  check("textLines missing content", lines.length === 0);
  const l2 = textLines(({ type: "emailText", content: [{ type: "paragraph", content: [{ type: "text", marks: null }] }] }) as unknown as EmailBlockNode);
  check("textLines null marks no-throw", l2.length === 1 && l2[0].runs.length === 0);
  const l3 = textLines(({ type: "emailText", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link" }] }] }] }) as unknown as EmailBlockNode);
  check("textLines link without attrs", l3[0].runs[0].href === undefined);
}
check("docWordCount empty hero", docWordCount({ type: "doc", content: [{ type: "emailHero", attrs: { title: "", subtitle: "" } }] }) === 0);

// email validation edges
check("email empty rejected", !isValidEmail(""));
check("email whitespace rejected", !isValidEmail("   "));
check("email no-tld rejected", !isValidEmail("a@b"));
check("email 1-char tld rejected", !isValidEmail("a@b.c"));
check("email uppercase ok", isValidEmail("A@B.CO"));
check("email padded ok", isValidEmail("  a@b.co  "));
check("email inner space rejected", !isValidEmail("a b@c.co"));
check("email double @ rejected", !isValidEmail("a@@b.co"));
check("BUG? email a@.co accepted", !isValidEmail("a@.co"), `isValidEmail("a@.co")=${isValidEmail("a@.co")}`);
check("BUG? email a@b..co accepted", !isValidEmail("a@b..co"), `isValidEmail("a@b..co")=${isValidEmail("a@b..co")}`);

// CSV import: cap boundary 10000 vs 10001
{
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ row: i + 2, values: { email: `u${i}@example.com`, name: "N" } }));
  const at = parseSubscriberCsv(rows(10_000));
  check("csv exactly 10000 rows ok", at.valid.length === 10_000 && at.errors.length === 0, `valid=${at.valid.length} errors=${at.errors.length}`);
  const over = parseSubscriberCsv(rows(10_001));
  check("csv 10001 rows capped", over.valid.length === 10_000 && over.errors.length === 1 && /capped/i.test(over.errors[0].message), `valid=${over.valid.length} errors=${over.errors.length}`);
  check("csv cap constant", SUBSCRIBER_CSV_CAP === 10_000);
}
{
  const r = parseSubscriberCsv([
    { row: 2, values: { email: "User@X.com ", name: "Ann Müller" } },
    { row: 3, values: { email: "user@x.com", name: "dup-case" } },
    { row: 4, values: { email: "  USER@x.COM", name: "dup-space" } },
    { row: 5, values: { email: "ünïcode@exämple.com", name: "" } },
  ]);
  check("csv case/space-insensitive dupes", r.valid.length === 2 && r.errors.length === 2, JSON.stringify(r.errors));
  check("csv name not lowercased, unicode kept", r.valid[0].name === "Ann Müller");
  check("csv unicode email accepted", r.valid[1].email === "ünïcode@exämple.com");
  check("csv empty input", parseSubscriberCsv([]).valid.length === 0);
}

// column mapping edges
check("mapSubscriberColumns padded header", mapSubscriberColumns(["  EMAIL  "])?.email === "  EMAIL  ");
check("mapSubscriberColumns e-mail variant", mapSubscriberColumns(["E-mail", "First Name"])?.email === "E-mail");
check("mapSubscriberColumns emailaddress", mapSubscriberColumns(["EmailAddress"])?.email === "EmailAddress");
check("mapSubscriberColumns empty", mapSubscriberColumns([]) === null);
{
  const m = mapSubscriberColumns(["email", "Email"]);
  check("mapSubscriberColumns duplicate headers first wins", m?.email === "email");
}

// unsubscribe enforcement edges
check("unsubscribeUrl encodes token", unsubscribeUrlFor(BASE, "a b&c=") === `${BASE}/api/newsletter/unsubscribe?token=a%20b%26c%3D`);
check("unsubscribeUrl strips trailing slash", unsubscribeUrlFor(BASE + "/", "t") === `${BASE}/api/newsletter/unsubscribe?token=t`);
{
  const withFooter = normalizeDoc({ type: "doc", content: [{ type: "emailFooter", attrs: { unsubUrl: "https://x.com/preferences" } }] });
  check("footer without unsubscribe keyword not detected", !docHasUnsubscribe(withFooter));
  const ensured = ensureUnsubscribe(withFooter, unsubscribeUrlFor(BASE, "t"));
  check("ensureUnsubscribe appends when missing", ensured.content.length === 2 && docHasUnsubscribe(ensured));
  check("ensureUnsubscribe does not mutate input", withFooter.content.length === 1);
}
{
  const btn = normalizeDoc({ type: "doc", content: [{ type: "emailButton", attrs: { href: "https://x.com/a?next=/unsubscribe" } }] });
  check("button unsubscribe path detected", docHasUnsubscribe(btn));
  const emptyDoc: EmailTiptapDoc = { type: "doc", content: [] };
  check("ensureUnsubscribe on empty doc", ensureUnsubscribe(emptyDoc, "u").content.length === 1);
}
{
  const g = (over: Record<string, unknown>) =>
    checkBroadcastGuardrails({
      domainStatus: "verified",
      testSentAt: new Date(),
      subscriberCount: 1,
      doc: sampleDoc(),
      unsubscribeUrl: "u",
      ...over,
    } as never);
  const r1 = checkBroadcastGuardrails({ domainStatus: "verified", testSentAt: new Date().toISOString(), subscriberCount: 1, doc: sampleDoc(), unsubscribeUrl: unsubscribeUrlFor(BASE, "t") });
  check("guardrail string testSentAt truthy", r1.ok);
  void g;
}

console.log(`[blocks] done`);

// ===========================================================================
// 2. newsletter/render.tsx
// ===========================================================================
section = "render";

{
  const html = await renderNewsletter({ type: "doc", content: [] }, { baseUrl: BASE });
  check("empty doc renders with unsubscribe", html.includes("/unsubscribe") && html.includes("Unsubscribe"));
  const noTok = await renderNewsletter(sampleDoc(), { baseUrl: BASE });
  check("no token → plain /unsubscribe link", noTok.includes(`${BASE}/unsubscribe`) && !noTok.includes("token="));
  const uni = await renderNewsletter(
    normalizeDoc({
      type: "doc",
      content: [
        { type: "emailHero", attrs: { title: "مرحبا 🌍 שלום" } },
        { type: "emailText", content: [{ type: "paragraph", content: [{ type: "text", text: "emoji 🎉 rtl עברית" }] }] },
      ],
    }),
    { baseUrl: BASE, unsubscribeToken: "t" },
  );
  check("unicode/emoji/RTL rendered", uni.includes("مرحبا") && uni.includes("🎉") && uni.includes("עברית"));
  const big = await renderNewsletter(
    { type: "doc", content: [{ type: "emailText", content: [{ type: "paragraph", content: [{ type: "text", text: "z".repeat(100_000) }] }] }] },
    { baseUrl: BASE },
  );
  check("100k char text renders", big.includes("z".repeat(1000)));
  const rel = await renderNewsletter(
    normalizeDoc({ type: "doc", content: [{ type: "emailImage", attrs: { src: "/img.png", alt: "i" } }] }),
    { baseUrl: BASE + "/", unsubscribeToken: "t" },
  );
  check("relative src absolutized", rel.includes(`${BASE}/img.png`));
  const rel2 = await renderNewsletter(
    normalizeDoc({ type: "doc", content: [{ type: "emailImage", attrs: { src: "img.png", alt: "i" } }] }),
    { baseUrl: BASE, unsubscribeToken: "t" },
  );
  check("bare relative src absolutized", rel2.includes(`${BASE}/img.png`));
  const js = await renderNewsletter(
    normalizeDoc({ type: "doc", content: [{ type: "emailButton", attrs: { label: "Click", href: "javascript:alert(1)" } }] }),
    { baseUrl: BASE, unsubscribeToken: "t" },
  );
  check("FIXED: javascript: button href neutralized", !js.includes('href="javascript:'), "button href rendered raw");
  check("FIXED: javascript: button href becomes inert", js.includes('href="#"'), "button href not neutralized to #");
  const jsText = await renderNewsletter(
    normalizeDoc({ type: "doc", content: [{ type: "emailText", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "JaVaScRiPt:alert(2)" } }] }] }] }] }),
    { baseUrl: BASE, unsubscribeToken: "t" },
  );
  check("FIXED: javascript: text-link neutralized (mixed case)", !/href="[Jj][Aa][Vv][Aa][Ss][Cc][Rr][Ii][Pp][Tt]:/.test(jsText), "text link href rendered raw");
  const jsObf = await renderNewsletter(
    normalizeDoc({ type: "doc", content: [{ type: "emailButton", attrs: { label: "Click", href: "  java\tscript:alert(3)" } }] }),
    { baseUrl: BASE, unsubscribeToken: "t" },
  );
  check("FIXED: whitespace/control-char obfuscated javascript: neutralized", !/javascript:/i.test(jsObf), "obfuscated scheme rendered raw");
  const jsData = await renderNewsletter(
    normalizeDoc({ type: "doc", content: [{ type: "emailButton", attrs: { label: "Click", href: "data:text/html,<script>alert(4)</script>" } }] }),
    { baseUrl: BASE, unsubscribeToken: "t" },
  );
  check("FIXED: data: button href neutralized", !jsData.includes('href="data:'), "data: href rendered raw");
  const okLink = await renderNewsletter(
    normalizeDoc({ type: "doc", content: [{ type: "emailButton", attrs: { label: "Go", href: "https://example.com/a?b=1" } }] }),
    { baseUrl: BASE, unsubscribeToken: "t" },
  );
  check("FIXED: legitimate https: button href preserved", okLink.includes('href="https://example.com/a?b=1"'), "legit href broken");
  const prev = await renderNewsletter(sampleDoc(), { baseUrl: BASE, previewText: "Sneak peek 👀" });
  check("preview text rendered", prev.includes("Sneak peek"));
  const logoRel = await renderNewsletter(
    normalizeDoc({ type: "doc", content: [{ type: "emailHeader", attrs: { logoUrl: "logo.png", tagline: "" } }] }),
    { baseUrl: BASE, unsubscribeToken: "t" },
  );
  check("relative logo absolutized", logoRel.includes(`${BASE}/logo.png`));
  const emptyImg = await renderNewsletter(
    normalizeDoc({ type: "doc", content: [{ type: "emailImage", attrs: { src: "", alt: "x" } }] }),
    { baseUrl: BASE, unsubscribeToken: "t" },
  );
  check("empty image src renders nothing", !emptyImg.includes("<img") || !emptyImg.includes('alt="x"'));
  const tokSpecial = await renderNewsletter(sampleDoc(), { baseUrl: BASE, unsubscribeToken: "a b&=" });
  check("special token encoded in html", tokSpecial.includes("token=a%20b%26%3D"));
}

// ===========================================================================
// 3. newsletter/resend.ts (MockResendPort)
// ===========================================================================
section = "resend-mock";

{
  const m = new MockResendPort();
  const empty = await m.sendBatch([]);
  check("mock empty batch → no ids", empty.ids.length === 0 && m.batchSends.length === 1);
  let threw = "";
  try {
    await m.getDomain("nope");
  } catch (e) {
    threw = e instanceof Error ? e.message : "";
  }
  check("mock unknown domain throws", /unknown domain/.test(threw), threw);
  await m.createContact("seg", { email: "dup@x.com" });
  await m.createContact("seg", { email: "dup@x.com" });
  check("mock allows duplicate contacts", m.contacts.length === 2);
  const segA = await m.createSegment("A");
  const segB = await m.createSegment("B");
  check("mock segment ids unique", segA.id !== segB.id);
  const d1 = await m.createDomain("Example.COM");
  check("mock domain name not normalized", d1.records.every((r) => typeof r.name === "string"));
}

// ===========================================================================
// 3b. newsletter/webhook-auth.ts — fail-closed Resend webhook gate (day-1, H2)
// ===========================================================================
section = "webhook-auth";

{
  const { verifyWebhookRequest } = await import("@/lib/newsletter/webhook-auth");
  const raw = JSON.stringify({ type: "email.bounced", data: { email: "a@x.com" } });
  const req = (headers: Record<string, string> = {}) =>
    new Request("http://localhost/api/newsletter/webhooks/resend", {
      method: "POST",
      headers,
    });
  const keepSecret = process.env.RESEND_WEBHOOK_SECRET;
  const keepAllow = process.env.ALLOW_UNSIGNED_WEBHOOKS;

  // fail closed: no secret, no opt-in → 401, never null
  delete process.env.RESEND_WEBHOOK_SECRET;
  delete process.env.ALLOW_UNSIGNED_WEBHOOKS;
  const denied = await verifyWebhookRequest(req(), raw);
  check("FIXED: unsigned webhook rejected without secret (fail closed)",
    denied instanceof Response && denied.status === 401);

  // explicit dev opt-in → allowed
  process.env.ALLOW_UNSIGNED_WEBHOOKS = "true";
  check("ALLOW_UNSIGNED_WEBHOOKS=true permits unsigned (dev only)",
    (await verifyWebhookRequest(req(), raw)) === null);

  // secret set → Svix verification required; forged/unsigned → 401
  process.env.RESEND_WEBHOOK_SECRET = "whsec_test";
  delete process.env.ALLOW_UNSIGNED_WEBHOOKS;
  const forged = await verifyWebhookRequest(req(), raw);
  check("secret set: unsigned payload rejected", forged instanceof Response && forged.status === 401);

  if (keepSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
  else process.env.RESEND_WEBHOOK_SECRET = keepSecret;
  if (keepAllow === undefined) delete process.env.ALLOW_UNSIGNED_WEBHOOKS;
  else process.env.ALLOW_UNSIGNED_WEBHOOKS = keepAllow;
}

// ===========================================================================
// 4. newsletter/service.ts — settings, domains, lists, import, send, webhooks
// ===========================================================================
section = "newsletter-service";

check("appBaseUrl strips trailing slash", appBaseUrl() === "https://news.example.com");

// --- fake db -----------------------------------------------------------------
interface Row { [k: string]: unknown }
interface NlState {
  lists: Map<string, Row>;
  subs: Map<string, Row>;
  domains: Map<string, Row>;
  settings: Row | null;
  broadcasts: Map<string, Row>;
  audit: Row[];
}
let subSeq = 0;
function nlDb(state: NlState) {
  return {
    newsletterSettings: {
      findUnique: async () => state.settings,
      upsert: async ({ create, update }: { create: Row; update: Row }) => {
        state.settings = { ...(state.settings ?? {}), ...create, ...update };
        return state.settings;
      },
    },
    newsletterDomain: {
      findUnique: async ({ where }: { where: Row }) => {
        if ((where as Row).id) { const dd = state.domains.get((where as Row).id as string); return dd ? { ...dd } : null; }
        const k = where as { workspaceId_domain?: { workspaceId: string; domain: string } };
        if (k.workspaceId_domain)
          return (() => { const dd = [...state.domains.values()].find((d) => d.domain === k.workspaceId_domain!.domain); return dd ? { ...dd } : null; })();
        return null;
      },
      findFirst: async ({ where }: { where: Row }) => {
        const w = where as { id?: string; workspaceId?: string };
        return (() => { const dd = [...state.domains.values()].find((d) => (!w.id || d.id === w.id) && (!w.workspaceId || d.workspaceId === w.workspaceId)); return dd ? { ...dd } : null; })();
      },
      create: async ({ data }: { data: Row }) => {
        const row = { id: `dom-${state.domains.size + 1}`, ...data };
        state.domains.set(row.id as string, row);
        return row;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = state.domains.get((where as { id: string }).id)!;
        Object.assign(row, data);
        return row;
      },
    },
    newsletterList: {
      findFirst: async ({ where }: { where: Row }) => {
        const w = where as { id?: string; projectId?: string };
        const l = [...state.lists.values()].find((x) => (!w.id || x.id === w.id) && (!w.projectId || x.projectId === w.projectId));
        return l ? { ...l } : null;
      },
      create: async ({ data }: { data: Row }) => {
        const row = { id: `list-${state.lists.size + 1}`, ...data };
        state.lists.set(row.id as string, row);
        return row;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = state.lists.get((where as { id: string }).id)!;
        Object.assign(row, data);
        return row;
      },
    },
    subscriber: {
      findMany: async ({ where }: { where: Row }) => {
        const w = where as { listId?: string; status?: string; email?: string };
        return [...state.subs.values()]
          .filter(
            (s) => (!w.listId || s.listId === w.listId) && (!w.status || s.status === w.status) && (!w.email || s.email === w.email),
          )
          .map((s) => ({ ...s }));
      },
      findUnique: async ({ where }: { where: Row }) => {
        const w = where as { token?: string };
        const s = [...state.subs.values()].find((x) => x.token === w.token);
        if (!s) return null;
        const list = state.lists.get(s.listId as string)!;
        return { ...s, list: { id: list.id, name: list.name, projectId: list.projectId, resendAudienceId: list.resendAudienceId, project: { workspaceId: "ws-1" } } };
      },
      create: async ({ data }: { data: Row }) => {
        subSeq += 1;
        const row = { id: `sub-${subSeq}`, token: `tok-${subSeq}`, ...data };
        state.subs.set(row.id as string, row);
        return row;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = state.subs.get((where as { id: string }).id)!;
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const w = where as { email?: string; status?: string };
        let count = 0;
        for (const s of state.subs.values()) {
          if ((!w.email || s.email === w.email) && (!w.status || s.status === w.status)) {
            Object.assign(s, data);
            count += 1;
          }
        }
        return { count };
      },
      count: async ({ where }: { where: Row }) => {
        const w = where as { listId?: string; status?: string };
        return [...state.subs.values()].filter((s) => (!w.listId || s.listId === w.listId) && (!w.status || s.status === w.status)).length;
      },
    },
    newsletterBroadcast: {
      findFirst: async ({ where }: { where: Row }) => {
        const w = where as { id?: string; projectId?: string };
        const b = [...state.broadcasts.values()].find((x) => (!w.id || x.id === w.id) && (!w.projectId || x.projectId === w.projectId));
        return b ? { ...b, list: { name: "L" }, domain: state.domains.get(b.domainId as string) } : null;
      },
      findUnique: async ({ where }: { where: Row }) => {
        const bb = state.broadcasts.get((where as { id: string }).id);
        return bb ? { ...bb } : null;
      },
      findMany: async ({ where }: { where: Row }) => {
        const w = where as { status?: string; scheduledAt?: { lte?: Date }; project?: { workspaceId?: string } };
        return [...state.broadcasts.values()]
          .filter((b) => (!w.status || b.status === w.status) && (!w.scheduledAt?.lte || (b.scheduledAt as Date) <= w.scheduledAt.lte!))
          .slice(0, 25)
          .map((b) => ({ ...b, project: { workspaceId: "ws-1", id: b.projectId } }));
      },
      create: async ({ data }: { data: Row }) => {
        const row = { id: `bc-${state.broadcasts.size + 1}`, ...data };
        state.broadcasts.set(row.id as string, row);
        return row;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = state.broadcasts.get((where as { id: string }).id)!;
        Object.assign(row, data);
        return row;
      },
      // Day-1 (edge #8): atomic send claim support.
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const w = where as { id?: string; projectId?: string; status?: { notIn?: string[] } };
        let count = 0;
        for (const b of state.broadcasts.values()) {
          if (w.id !== undefined && (b as Row).id !== w.id) continue;
          if (w.projectId !== undefined && (b as Row).projectId !== w.projectId) continue;
          if (w.status?.notIn && (w.status.notIn as string[]).includes((b as Row).status as string)) continue;
          Object.assign(b, data);
          count++;
        }
        return { count };
      },
    },
    brandKit: { findFirst: async () => null },
    fileChangeLog: { create: async ({ data }: { data: Row }) => { state.audit.push(data); return data; } },
  } as unknown as PrismaClient;
}
function nlState(): NlState {
  return { lists: new Map(), subs: new Map(), domains: new Map(), settings: null, broadcasts: new Map(), audit: [] };
}

// --- Resend key settings -------------------------------------------------------
{
  const db = nlDb(nlState());
  const { secrets } = await import("@/lib/secrets");
  const ok = await setResendKey(db, "ws-1", "re_abcdefghij123456");
  check("setResendKey hint", typeof ok.hint === "string" && ok.hint.length > 0);
  check("setResendKey decrypt round-trip", secrets().decrypt(((await db.newsletterSettings.findUnique({ where: { workspaceId: "ws-1" } })) as Row).resendKeyEnc as string) === "re_abcdefghij123456");
  for (const bad of ["", "   ", "re_short", "sk_live_1234567890", "re_abc defghi", "re_"]) {
    let threw = false;
    try {
      await setResendKey(db, "ws-1", bad);
    } catch {
      threw = true;
    }
    check(`setResendKey rejects ${JSON.stringify(bad)}`, threw);
  }
  check("setResendKey trims whitespace", (await setResendKey(db, "ws-1", "  re_abcdefghij123456\n")).hint.length > 0);
  const port = await getResendPort(db, "ws-1", (k) => new MockResendPort() as unknown as never);
  check("getResendPort with key", port !== null);
  const db2 = nlDb(nlState());
  check("getResendPort no settings → null", (await getResendPort(db2, "ws-1", () => { throw new Error("must not be called"); })) === null);
}

// --- domains -------------------------------------------------------------------
{
  const state = nlState();
  const db = nlDb(state);
  const port = new MockResendPort();
  const row = (await addDomain(db, "ws-1", "HTTPS://Example.com/blog/", port)) as Row;
  check("addDomain normalizes", row.domain === "example.com", String(row.domain));
  for (const bad of ["", "   ", "not a domain", "a", "x_y.com", "-bad.com", "example.com:8080"]) {
    let threw = "";
    try {
      await addDomain(db, "ws-1", bad, port);
    } catch (e) {
      threw = e instanceof Error ? e.message : "";
    }
    check(`addDomain rejects ${JSON.stringify(bad)}`, /invalid domain/i.test(threw), threw);
  }
  let dup = "";
  try {
    await addDomain(db, "ws-1", "example.com", port);
  } catch (e) {
    dup = e instanceof Error ? e.message : "";
  }
  check("addDomain duplicate blocked", /already set up/i.test(dup), dup);

  let threw = "";
  try {
    await refreshDomain(db, "nope", port);
  } catch (e) {
    threw = e instanceof Error ? e.message : "";
  }
  check("refreshDomain unknown id throws", /not found/i.test(threw));
  const auditsBefore = state.audit.length;
  const updated = (await refreshDomain(db, row.id as string, port)) as Row;
  check("refreshDomain verifies", updated.status === "verified");
  check("refreshDomain audit once", state.audit.length === auditsBefore + 1);
  await refreshDomain(db, row.id as string, port);
  check("refreshDomain no duplicate audit", state.audit.length === auditsBefore + 1);

  const v = await requireVerifiedDomain(db, row.id as string, "ws-1");
  check("requireVerifiedDomain ok", (v as Row).id === row.id);
  const state2 = nlState();
  const db2 = nlDb(state2);
  const port2 = new MockResendPort();
  const pend = (await addDomain(db2, "ws-1", "pending.com", port2)) as Row;
  let t2 = "";
  try {
    await requireVerifiedDomain(db2, pend.id as string, "ws-1");
  } catch (e) {
    t2 = e instanceof Error ? e.message : "";
  }
  check("requireVerifiedDomain blocks pending", /not verified/i.test(t2), t2);
  let t3 = "";
  try {
    await requireVerifiedDomain(db2, "missing", "ws-1");
  } catch (e) {
    t3 = e instanceof Error ? e.message : "";
  }
  check("requireVerifiedDomain missing throws", /not found/i.test(t3), t3);
}

// --- lists ---------------------------------------------------------------------
{
  const db = nlDb(nlState());
  let threw = "";
  try {
    await createList(db, "p1", "ws-1", "   ", false, null);
  } catch (e) {
    threw = e instanceof Error ? e.message : "";
  }
  check("createList blank name blocked", /required/i.test(threw), threw);
  const a = (await createList(db, "p1", "ws-1", "News", false, null)) as Row;
  const b = (await createList(db, "p1", "ws-1", "News", false, null)) as Row;
  check("duplicate list names allowed (no uniqueness)", a.id !== b.id);
}

// --- CSV import edge cases -------------------------------------------------------
{
  const state = nlState();
  const db = nlDb(state);
  const port = new MockResendPort();
  const list = (await createList(db, "p1", "ws-1", "L", false, port)) as Row;

  const csv = "\uFEFFemail,name\r\n\"a@x.com\",\"Smith, Ann\"\r\n\"b@x.com\",\"Line1\nLine2\"\r\nc@x.com\r\nd@x.com,Extra,Ignored-Column\r\nbad-email,x\r\nA@X.COM,dup-case\r\n";
  const out = await importSubscribers(db, list.id as string, "ws-1", "p1", csv, port);
  check("import BOM + quoted comma", out.imported >= 4, JSON.stringify(out));
  check("import invalid email error", out.errors.some((e) => /invalid email/i.test(e.message)));
  check("import dup-case error", out.errors.some((e) => /duplicate/i.test(e.message)));
  check("import quoted name kept", [...state.subs.values()].some((s) => s.name === "Smith, Ann"));
  check("import quoted newline kept", [...state.subs.values()].some((s) => (s.name as string).includes("\n")));
  check("import missing name → null", [...state.subs.values()].some((s) => s.email === "c@x.com" && s.name === null));
  check("import extra column ignored", [...state.subs.values()].some((s) => s.email === "d@x.com"));

  // existing-email skip is case-insensitive
  const out2 = await importSubscribers(db, list.id as string, "ws-1", "p1", "email\nA@X.COM\n", port);
  check("import skips existing case-insensitively", out2.imported === 0 && out2.skipped === 1, JSON.stringify(out2));

  // semicolon-delimited → clear error
  let t = "";
  try {
    await importSubscribers(db, list.id as string, "ws-1", "p1", "email;name\na@x.com;x\n", port);
  } catch (e) {
    t = e instanceof Error ? e.message : "";
  }
  check("import semicolon csv clear error", /"email" column/i.test(t), t);
  let t2 = "";
  try {
    await importSubscribers(db, list.id as string, "ws-1", "p1", "", port);
  } catch (e) {
    t2 = e instanceof Error ? e.message : "";
  }
  check("import empty csv error", /no header/i.test(t2), t2);
  const headerOnly = await importSubscribers(db, list.id as string, "ws-1", "p1", "email,name\n", port);
  check("import header-only → zero", headerOnly.imported === 0 && headerOnly.errors.length === 0);
  let t3 = "";
  try {
    await importSubscribers(db, "missing", "ws-1", "p1", "email\na@x.com\n", port);
  } catch (e) {
    t3 = e instanceof Error ? e.message : "";
  }
  check("import missing list throws", /list not found/i.test(t3), t3);
  // port null → still imports locally
  const out3 = await importSubscribers(db, list.id as string, "ws-1", "p1", "email\nz@x.com\n", null);
  check("import without port works", out3.imported === 1);
}

// --- unsubscribe token -----------------------------------------------------------
{
  const state = nlState();
  const db = nlDb(state);
  const list = (await createList(db, "p1", "ws-1", "L", false, null)) as Row;
  await importSubscribers(db, list.id as string, "ws-1", "p1", "email\na@x.com\n", null);
  const sub = [...state.subs.values()][0];
  check("unsubscribe unknown token → null", (await unsubscribeByToken(db, "nope")) === null);
  const r1 = await unsubscribeByToken(db, sub.token as string);
  check("unsubscribe works", r1?.email === "a@x.com" && r1.already === false);
  check("unsubscribe flips status", sub.status === "unsubscribed");
  const audits = state.audit.length;
  const r2 = await unsubscribeByToken(db, sub.token as string);
  check("unsubscribe idempotent", r2?.already === true && state.audit.length === audits);
}

// --- sendBroadcast: double-send + concurrency --------------------------------------
{
  const mk = () => {
    const state = nlState();
    const db = nlDb(state);
    const list = { id: "l1", projectId: "p1", name: "L" };
    state.lists.set("l1", list as Row);
    state.domains.set("d1", { id: "d1", workspaceId: "ws-1", domain: "example.com", status: "verified" });
    state.broadcasts.set("b1", {
      id: "b1", projectId: "p1", listId: "l1", domainId: "d1", subject: "News",
      templateSnapshot: sampleDoc(), brandKitId: null, status: "draft", testSentAt: new Date(), error: null,
    });
    return { state, db };
  };
  const addSub = (state: NlState, email: string) => {
    subSeq += 1;
    state.subs.set(`s${subSeq}`, { id: `s${subSeq}`, listId: "l1", email, name: null, status: "subscribed", token: `t${subSeq}` });
  };

  // sequential double send
  {
    const { state, db } = mk();
    addSub(state, "a@x.com");
    const port = new MockResendPort();
    const r = await sendBroadcast(db, "b1", "ws-1", "p1", port);
    check("sendBroadcast sends", r.sent === 1);
    let threw = "";
    try {
      await sendBroadcast(db, "b1", "ws-1", "p1", port);
    } catch (e) {
      threw = e instanceof Error ? e.message : "";
    }
    check("sendBroadcast second call blocked", /already sent/i.test(threw), threw);
    check("no duplicate batch on resend", port.batchSends.length === 1);
  }
  // concurrent double send — atomic claim: exactly one winner (FIXED day-1)
  {
    const { state, db } = mk();
    addSub(state, "a@x.com");
    const port = new MockResendPort();
    const [r1, r2] = await Promise.allSettled([
      sendBroadcast(db, "b1", "ws-1", "p1", port),
      sendBroadcast(db, "b1", "ws-1", "p1", port),
    ]);
    const sends = port.batchSends.length;
    check("FIXED: concurrent sendBroadcast sends exactly once", sends === 1, `batchSends=${sends} r1=${r1.status} r2=${r2.status}`);
    const loserMsg = r1.status === "rejected" ? String(r1.reason) : r2.status === "rejected" ? String(r2.reason) : "";
    check("FIXED: losing sender gets already-sending error", /already sending/i.test(loserMsg), loserMsg);
  }
  // resumable send: crash mid-send → retry skips already-sent recipients (FIXED day-1, edge #10)
  {
    const { state, db } = mk();
    for (let i = 0; i < 55; i++) addSub(state, `u${i}@x.com`);
    const port = new MockResendPort();
    let batches = 0;
    const origBatch = port.sendBatch.bind(port);
    port.sendBatch = async (emails) => {
      batches += 1;
      if (batches === 2) throw new Error("connection reset mid-send");
      return origBatch(emails);
    };
    let threw = "";
    try {
      await sendBroadcast(db, "b1", "ws-1", "p1", port);
    } catch (e) {
      threw = e instanceof Error ? e.message : "";
    }
    check("mid-send crash throws", /connection reset/.test(threw), threw);
    const mid = state.broadcasts.get("b1") as Row;
    check("FIXED: crash leaves broadcast failed (not stuck sending)", mid.status === "failed", `status=${mid.status}`);
    check("FIXED: progress persisted for resume", (mid.stats as { sent?: number } | null)?.sent === 50, `stats=${JSON.stringify((mid.stats as { sent?: number }).sent)}`);
    // retry: first chunk skipped, only the remaining 5 sent
    const port2 = new MockResendPort();
    const r = await sendBroadcast(db, "b1", "ws-1", "p1", port2);
    const allSent = port2.batchSends.flat().map((e) => e.to).sort();
    const dupes = allSent.filter((e, i) => allSent.indexOf(e) !== i);
    check("FIXED: retry sends only unsent recipients", r.sent === 55 && allSent.length === 5 && dupes.length === 0,
      `sent=${r.sent} total=${allSent.length} dupes=${dupes.length}`);
  }
  // guardrail: zero subscribers
  {
    const { db } = mk();
    const port = new MockResendPort();
    let threw = "";
    try {
      await sendBroadcast(db, "b1", "ws-1", "p1", port);
    } catch (e) {
      threw = e instanceof Error ? e.message : "";
    }
    check("sendBroadcast zero subs blocked", /no subscribed recipients/i.test(threw), threw);
    check("failed status recorded", ((await db.newsletterBroadcast.findUnique({ where: { id: "b1" } })) as Row).status === "failed");
    check("no send on guardrail failure", port.batchSends.length === 0);
  }
  // provider throws mid-send → failed
  {
    const { state, db } = mk();
    addSub(state, "a@x.com");
    const port = new MockResendPort();
    port.sendBatch = async () => { throw new Error("Resend 500"); };
    let threw = "";
    try {
      await sendBroadcast(db, "b1", "ws-1", "p1", port);
    } catch (e) {
      threw = e instanceof Error ? e.message : "";
    }
    check("sendBroadcast provider failure → failed", /Resend 500/.test(threw) && ((await db.newsletterBroadcast.findUnique({ where: { id: "b1" } })) as Row).status === "failed", threw);
  }
}

// --- testSend ----------------------------------------------------------------------
{
  const state = nlState();
  const db = nlDb(state);
  state.lists.set("l1", { id: "l1", projectId: "p1", name: "L" } as Row);
  state.domains.set("d1", { id: "d1", workspaceId: "ws-1", domain: "example.com", status: "verified" });
  state.broadcasts.set("b1", { id: "b1", projectId: "p1", listId: "l1", domainId: "d1", subject: "S", templateSnapshot: sampleDoc(), brandKitId: null, status: "draft", testSentAt: null });
  const port = new MockResendPort();
  let threw = "";
  try {
    await testSend(db, "b1", "ws-1", "p1", "not-an-email", port);
  } catch (e) {
    threw = e instanceof Error ? e.message : "";
  }
  check("testSend invalid email blocked", /valid test recipient/i.test(threw), threw);
  await testSend(db, "b1", "ws-1", "p1", "Me@X.com ", port);
  const b = (await db.newsletterBroadcast.findUnique({ where: { id: "b1" } })) as Row;
  check("testSend sets testSentAt/To", b.testSentAt instanceof Date && b.testSentTo === "me@x.com");
  check("testSend banner injected", port.testEmails[0].html.includes('data-marketr-test="true"'));
  check("testSend subject prefixed", port.testEmails[0].subject === "[TEST] S");
  // unverified domain blocked
  state.domains.set("d2", { id: "d2", workspaceId: "ws-1", domain: "u.com", status: "pending" });
  state.broadcasts.set("b2", { id: "b2", projectId: "p1", listId: "l1", domainId: "d2", subject: "S", templateSnapshot: sampleDoc(), brandKitId: null, status: "draft", testSentAt: null });
  let t2 = "";
  try {
    await testSend(db, "b2", "ws-1", "p1", "me@x.com", port);
  } catch (e) {
    t2 = e instanceof Error ? e.message : "";
  }
  check("testSend unverified domain blocked", /not verified/i.test(t2), t2);
}

// --- cancelBroadcast -----------------------------------------------------------------
{
  const state = nlState();
  const db = nlDb(state);
  state.broadcasts.set("b1", { id: "b1", projectId: "p1", subject: "S", status: "scheduled" });
  state.broadcasts.set("b2", { id: "b2", projectId: "p1", subject: "S", status: "sent" });
  state.broadcasts.set("b3", { id: "b3", projectId: "p1", subject: "S", status: "sending" });
  await cancelBroadcast(db, "b1", "ws-1", "p1");
  check("cancelBroadcast scheduled → cancelled", ((await db.newsletterBroadcast.findUnique({ where: { id: "b1" } })) as Row).status === "cancelled");
  for (const [id, label] of [["b2", "sent"], ["b3", "sending"]] as const) {
    let threw = "";
    try {
      await cancelBroadcast(db, id, "ws-1", "p1");
    } catch (e) {
      threw = e instanceof Error ? e.message : "";
    }
    check(`cancelBroadcast ${label} blocked`, /cannot cancel/i.test(threw), threw);
  }
  let t = "";
  try {
    await cancelBroadcast(db, "missing", "ws-1", "p1");
  } catch (e) {
    t = e instanceof Error ? e.message : "";
  }
  check("cancelBroadcast missing throws", /not found/i.test(t), t);
}

// --- runDueBroadcasts ------------------------------------------------------------------
{
  const state = nlState();
  const db = nlDb(state);
  state.lists.set("l1", { id: "l1", projectId: "p1", name: "L" } as Row);
  state.domains.set("d1", { id: "d1", workspaceId: "ws-1", domain: "example.com", status: "verified" });
  const past = new Date(Date.now() - 1000);
  const future = new Date(Date.now() + 3600_000);
  state.broadcasts.set("due", { id: "due", projectId: "p1", listId: "l1", domainId: "d1", subject: "D", templateSnapshot: sampleDoc(), brandKitId: null, status: "scheduled", scheduledAt: past, testSentAt: new Date() });
  state.broadcasts.set("future", { id: "future", projectId: "p1", listId: "l1", domainId: "d1", subject: "F", templateSnapshot: sampleDoc(), brandKitId: null, status: "scheduled", scheduledAt: future, testSentAt: new Date() });
  subSeq += 1;
  state.subs.set("s1", { id: "s1", listId: "l1", email: "a@x.com", name: null, status: "subscribed", token: "t1" });
  const port = new MockResendPort();
  const r = await runDueBroadcasts(db, async () => port);
  check("cron sends due", r.checked === 1 && r.sent === 1, JSON.stringify(r));
  check("cron skips future", ((await db.newsletterBroadcast.findUnique({ where: { id: "future" } })) as Row).status === "scheduled");

  // no port → failed, fail-closed
  const state2 = nlState();
  const db2 = nlDb(state2);
  state2.lists.set("l1", { id: "l1", projectId: "p1", name: "L" } as Row);
  state2.domains.set("d1", { id: "d1", workspaceId: "ws-1", domain: "example.com", status: "verified" });
  state2.broadcasts.set("due", { id: "due", projectId: "p1", listId: "l1", domainId: "d1", subject: "D", templateSnapshot: sampleDoc(), brandKitId: null, status: "scheduled", scheduledAt: past, testSentAt: new Date() });
  const r2 = await runDueBroadcasts(db2, async () => null);
  check("cron no-key → failed fail-closed", r2.failed === 1 && ((await db2.newsletterBroadcast.findUnique({ where: { id: "due" } })) as Row).status === "failed", JSON.stringify(r2));
  check("cron no-key error message", /no resend api key/i.test((((await db2.newsletterBroadcast.findUnique({ where: { id: "due" } })) as Row).error as string) ?? ""));
}

// --- webhook: double + out-of-order delivery ---------------------------------------------
{
  const state = nlState();
  const db = nlDb(state);
  const mk = (email: string, status: string) => {
    subSeq += 1;
    state.subs.set(`s${subSeq}`, { id: `s${subSeq}`, listId: "l1", email, name: null, status, token: `t${subSeq}` });
  };
  mk("a@x.com", "subscribed");
  const w1 = await handleResendWebhook(db, { type: "email.bounced", data: { to: ["A@X.COM "] } });
  check("webhook bounce normalizes + updates", w1.handled && w1.updated === 1, JSON.stringify(w1));
  const w2 = await handleResendWebhook(db, { type: "email.bounced", data: { to: ["a@x.com"] } });
  check("webhook double delivery → 0 new", w2.handled && w2.updated === 0, JSON.stringify(w2));
  mk("b@x.com", "subscribed");
  await handleResendWebhook(db, { type: "email.complained", data: { email: "b@x.com" } });
  const w3 = await handleResendWebhook(db, { type: "email.bounced", data: { to: ["b@x.com"] } });
  const bsub = [...state.subs.values()].find((s) => s.email === "b@x.com")!;
  check("webhook out-of-order: first terminal state wins", w3.updated === 0 && bsub.status === "complained", `status=${bsub.status}`);
  const w4 = await handleResendWebhook(db, { type: "email.opened", data: {} });
  check("webhook ignores other events", !w4.handled && w4.updated === 0);
  const w5 = await handleResendWebhook(db, { type: "email.bounced", data: {} });
  check("webhook empty data handled", w5.handled && w5.updated === 0);
  const w6 = await handleResendWebhook(db, {});
  check("webhook empty event ignored", !w6.handled);
  const w7 = await handleResendWebhook(db, { type: "email.bounced", data: { to: ["", "  "] } });
  check("webhook blank recipients skipped", w7.handled && w7.updated === 0);
}

console.log(`[newsletter-service] done`);

// ===========================================================================
// 5. social/channels.ts — limits, validation, UTM, bucketing, retry math
// ===========================================================================
section = "social-channels";

import {
  ALL_SERVICES,
  CHANNEL_DEFS,
  MAX_DISPATCH_ATTEMPTS,
  RETRY_BACKOFF_MS,
  bucketPostsByDay,
  buildUtmUrl,
  nextRetryAt,
  resolveChannelContent,
  validatePostForChannels,
  type SocialContent,
  type SocialService,
} from "@/lib/social/channels";
import { MockBufferPort, isTransientBufferError } from "@/lib/social/buffer";
import {
  attemptDispatch,
  cancelPost,
  createPost,
  deletePost,
  dispatchPost,
  getBufferPort,
  hasBufferToken,
  normalizeService,
  refreshPostStatus,
  resolveTargetChannels,
  revokeBufferToken,
  runDueSocialPosts,
  sanitizeContent,
  setBufferToken,
  syncAnalytics,
  updatePost,
} from "@/lib/social/service";

const txt = (n: number) => "x".repeat(n);
const img = { type: "image" as const, url: "https://e.com/p.jpg" };
const vid = { type: "video" as const, url: "https://e.com/v.mp4" };
function sc(over: Partial<SocialContent> = {}): SocialContent {
  return { text: "Hello", perChannel: {}, media: [img], ...over };
}

// per-channel boundary: exactly-at-limit ok, one-over flagged
{
  const cases: Array<[SocialService, number]> = [
    ["twitter", 280], ["instagram", 2200], ["threads", 500], ["bluesky", 300],
    ["linkedin", 3000], ["facebook", 63206], ["youtube", 5000], ["pinterest", 800],
  ];
  for (const [svc, lim] of cases) {
    const media = svc === "tiktok" || svc === "youtube" ? [vid] : svc === "pinterest" ? [img] : svc === "instagram" ? [img] : [];
    const at = validatePostForChannels([svc], sc({ text: txt(lim), media: svc === "instagram" ? [img] : svc === "tiktok" ? [vid] : svc === "youtube" ? [vid] : svc === "pinterest" ? [img] : [] }));
    const over = validatePostForChannels([svc], sc({ text: txt(lim + 1), media: svc === "instagram" ? [img] : svc === "tiktok" ? [vid] : svc === "youtube" ? [vid] : svc === "pinterest" ? [img] : [] }));
    check(`${svc} at-limit ok`, at.length === 0, JSON.stringify(at));
    check(`${svc} one-over flagged`, over.length === 1 && over[0].field === "text", JSON.stringify(over));
    void media;
  }
}
{
  // emoji surrogate counting follows JS string length semantics
  const e140 = "😀".repeat(140); // length 280
  check("emoji 140 = twitter at-limit", validatePostForChannels(["twitter"], sc({ text: e140 })).length === 0);
  check("emoji 141 over twitter limit", validatePostForChannels(["twitter"], sc({ text: "😀".repeat(141) })).length === 1);
  check("empty services → no issues", validatePostForChannels([], sc()).length === 0);
  const unk = validatePostForChannels(["myspace" as SocialService], sc());
  check("unknown channel flagged", unk.length === 1 && /unknown channel/i.test(unk[0].message), JSON.stringify(unk));
  const ws = validatePostForChannels(["twitter"], sc({ text: " \t\n " }));
  check("whitespace-only text flagged", ws.length === 1 && ws[0].field === "text");
  const both = validatePostForChannels(["instagram"], sc({ text: "", media: [] }));
  check("instagram empty text + no media → 2 issues", both.length === 2, JSON.stringify(both));
  const linkMedia = validatePostForChannels(["instagram"], sc({ text: "hi", media: [{ type: "link", url: "https://e.com" }] }));
  check("instagram link-only media flagged", linkMedia.length === 1 && linkMedia[0].field === "media");
}

// UTM edges
{
  check("utm with fragment", (buildUtmUrl("https://e.com/a#sec", { source: "s" }) ?? "").startsWith("https://e.com/a?utm_source=s#sec"));
  check("utm relative url passthrough", buildUtmUrl("page/a", { source: "s" }) === "page/a");
  check("utm empty string link → undefined", buildUtmUrl("", { source: "s" }) === undefined);
  check("utm whitespace values dropped", buildUtmUrl("https://e.com/a", { source: "  " }) === "https://e.com/a");
  check("utm overwrites existing param", (buildUtmUrl("https://e.com/a?utm_source=old", { source: "new" }) ?? "").includes("utm_source=new"));
  check("utm unicode value encoded", (buildUtmUrl("https://e.com/a", { campaign: " Frühling " }) ?? "").includes("utm_campaign="));
}

// bucketing: invalid dates, DST boundaries, offsets
{
  const posts = [
    { id: "a", scheduledFor: "2026-03-08T06:59:59Z", services: [] as never[], status: "s" }, // DST start day US
    { id: "b", scheduledFor: "2026-03-08T07:00:01Z", services: [] as never[], status: "s" },
    { id: "c", scheduledFor: "2026-11-01T05:30:00Z", services: [] as never[], status: "s" }, // DST end day US
    { id: "d", scheduledFor: "2026-10-05T14:00:00+02:00", services: [] as never[], status: "s" }, // = 12:00Z
    { id: "e", scheduledFor: "not-a-date", services: [] as never[], status: "s" },
    { id: "f", scheduledFor: null, services: [] as never[], status: "s" },
    { id: "g", scheduledFor: "2026-10-31T23:30:00-04:00", services: [] as never[], status: "s" }, // = Nov 1 03:30Z
  ];
  const b = bucketPostsByDay(posts, 2026, 3);
  check("DST-start day buckets UTC", (b.days.get(8) ?? []).length === 2, JSON.stringify([...b.days.keys()]));
  const b11 = bucketPostsByDay(posts, 2026, 11);
  check("DST-end day buckets UTC", (b11.days.get(1) ?? []).length === 2, JSON.stringify([...b11.days.keys()]));
  const b10 = bucketPostsByDay(posts, 2026, 10);
  check("offset string converted to UTC day", (b10.days.get(5) ?? []).length === 1 && (b10.days.get(31) ?? []).length === 0);
  check("invalid date + null + out-of-month counted", b10.outOfMonth === 6, String(b10.outOfMonth));
  const b11b = bucketPostsByDay(posts, 2026, 11);
  check("EDT offset pushes to next UTC day", (b11b.days.get(1) ?? []).length === 2, JSON.stringify([...b11b.days.keys()]));
}

// retry math
{
  const from = new Date("2026-01-01T00:00:00Z");
  const r0 = nextRetryAt(0, from);
  check("BUG? nextRetryAt(0) invalid date", !Number.isNaN(r0.getTime()), `got ${r0}`);
  const r1 = nextRetryAt(1, from).getTime();
  const r2 = nextRetryAt(2, from).getTime();
  const r3 = nextRetryAt(3, from).getTime();
  const r4 = nextRetryAt(4, from).getTime();
  check("backoff 5min/30min/2h", r1 - from.getTime() === 5 * 60_000 && r2 - from.getTime() === 30 * 60_000 && r3 - from.getTime() === 2 * 3600_000);
  check("backoff plateaus after table", r4 === r3);
  check("backoff table values", JSON.stringify(RETRY_BACKOFF_MS) === JSON.stringify([300000, 1800000, 7200000]));
  check("max attempts", MAX_DISPATCH_ATTEMPTS === 3);
}

// sanitize / normalize edges
{
  const s = sanitizeContent(null);
  check("sanitizeContent(null)", s.text === "" && s.media.length === 0 && s.link === undefined);
  const s2 = sanitizeContent({ text: "hi", link: "   ", utm: "nope", perChannel: { twitter: { media: [{ url: 123 }] } } } as never);
  check("sanitizeContent blank link dropped", s2.link === undefined);
  check("sanitizeContent non-object utm dropped", s2.utm === undefined);
  check("sanitizeContent non-string media url dropped", (s2.perChannel.twitter?.media ?? []).length === 0);
  const s3 = sanitizeContent({ text: "hi", media: [{ type: "weird", url: "https://e.com/a" }] } as never);
  check("sanitizeContent unknown media type → image", (s3.media[0] as { type: string }).type === "image");
  check("normalizeService case-insensitive", normalizeService("Twitter") === "twitter");
  check("normalizeService padded alias", normalizeService(" x ") === "twitter");
  check("normalizeService fb/ig", normalizeService("fb") === "facebook" && normalizeService("ig") === "instagram");
  check("normalizeService empty → null", normalizeService("  ") === null);
  check("normalizeService unknown → null", normalizeService("myspace") === null);
}

console.log(`[social-channels] done`);

// ===========================================================================
// 6. social/service.ts — dispatch, retries, cron, cancel
// ===========================================================================
section = "social-service";

interface SRow { [k: string]: unknown }
interface SState {
  posts: Map<string, SRow>;
  channels: Map<string, SRow>;
  settings: SRow | null;
  audit: SRow[];
}
function sDb(state: SState) {
  return {
    socialSettings: {
      findUnique: async () => state.settings,
      upsert: async ({ create, update }: { create: SRow; update: SRow }) => {
        state.settings = { ...(state.settings ?? {}), ...create, ...update };
        return state.settings;
      },
    },
    socialChannel: {
      findMany: async ({ where }: { where: SRow }) => {
        const w = (where ?? {}) as { projectId?: string; enabled?: boolean };
        return [...state.channels.values()]
          .filter((c) => (w.projectId === undefined || c.projectId === w.projectId) && (w.enabled === undefined || c.enabled === w.enabled))
          .map((c) => ({ ...c }));
      },
      update: async ({ where, data }: { where: SRow; data: SRow }) => {
        const row = state.channels.get((where as { id: string }).id)!;
        Object.assign(row, data);
        return row;
      },
    },
    socialPost: {
      findUniqueOrThrow: async ({ where }: { where: SRow }) => {
        const row = state.posts.get((where as { id: string }).id);
        if (!row) throw new Error("No SocialPost found");
        return { ...row, bufferUpdateIds: Array.isArray(row.bufferUpdateIds) ? [...(row.bufferUpdateIds as unknown[])] : row.bufferUpdateIds };
      },
      findUnique: async ({ where }: { where: SRow }) => state.posts.get((where as { id: string }).id) ?? null,
      findMany: async ({ where }: { where: SRow }) => {
        const w = where as { status?: string; scheduledFor?: { lte?: Date }; nextAttemptAt?: { lte?: Date }; OR?: SRow[]; project?: { workspaceId?: string } };
        const now = new Date();
        return [...state.posts.values()]
          .filter((p) => {
            if (w.status && p.status !== w.status) return false;
            if (w.OR) {
              const ok = w.OR.some((cond) => {
                const c = cond as { scheduledFor?: { lte?: Date }; nextAttemptAt?: { lte?: Date } };
                if (c.scheduledFor?.lte) return (p.scheduledFor as Date) <= c.scheduledFor.lte;
                if (c.nextAttemptAt?.lte) return !!p.nextAttemptAt && (p.nextAttemptAt as Date) <= c.nextAttemptAt.lte;
                return false;
              });
              if (!ok) return false;
            }
            return true;
          })
          .map((p) => ({ ...p, bufferUpdateIds: [...(p.bufferUpdateIds as unknown[])], project: { workspaceId: "ws-1" } }));
      },
      create: async ({ data }: { data: SRow }) => {
        const row = { id: `post-${state.posts.size + 1}`, status: "draft", attempts: 0, ...data };
        state.posts.set(row.id as string, row);
        return row;
      },
      update: async ({ where, data }: { where: SRow; data: SRow }) => {
        const row = state.posts.get((where as { id: string }).id)!;
        Object.assign(row, data);
        return row;
      },
      // Day-1 (edge #7): atomic dispatch claim + stale-claim reclaim support.
      updateMany: async ({ where, data }: { where: SRow; data: SRow }) => {
        const w = where as { id?: string; status?: string | { in?: string[]; notIn?: string[] }; updatedAt?: { lt?: Date } };
        let count = 0;
        for (const p of state.posts.values()) {
          const pr = p as SRow;
          if (w.id !== undefined && pr.id !== w.id) continue;
          if (typeof w.status === "string") { if (pr.status !== w.status) continue; }
          else {
            if (w.status?.in && !(w.status.in as string[]).includes(pr.status as string)) continue;
            if (w.status?.notIn && (w.status.notIn as string[]).includes(pr.status as string)) continue;
          }
          if (w.updatedAt?.lt && (!pr.updatedAt || (pr.updatedAt as Date) >= w.updatedAt.lt)) continue;
          Object.assign(p, data);
          count++;
        }
        return { count };
      },
      delete: async ({ where }: { where: SRow }) => {
        state.posts.delete((where as { id: string }).id);
      },
    },
    fileChangeLog: { create: async ({ data }: { data: SRow }) => { state.audit.push(data); return data; } },
  } as unknown as PrismaClient;
}
function sState(): SState {
  return { posts: new Map(), channels: new Map(), settings: null, audit: [] };
}
function addChannel(state: SState, service: string, enabled = true) {
  const id = `ch-${service}`;
  state.channels.set(id, { id, projectId: "proj-1", bufferProfileId: `prof-${service}`, service, handle: `@acme`, enabled });
}
function addPost(state: SState, over: SRow = {}): SRow {
  const row: SRow = {
    id: `post-${state.posts.size + 1}`, projectId: "proj-1", status: "draft",
    services: ["twitter"], content: sc(), scheduledFor: new Date(Date.now() + 3600_000),
    bufferUpdateIds: [], attempts: 0, nextAttemptAt: null, error: null, stats: null,
    ...over,
  };
  state.posts.set(row.id as string, row);
  return row;
}

// --- token settings ------------------------------------------------------------
{
  const db = sDb(sState());
  let threw = "";
  try {
    await setBufferToken(db, "ws-1", "   ");
  } catch (e) {
    threw = e instanceof Error ? e.message : "";
  }
  check("setBufferToken blank blocked", /required/i.test(threw), threw);
  await setBufferToken(db, "ws-1", "tok-123");
  check("hasBufferToken true", await hasBufferToken(db, "ws-1"));
  const { secrets } = await import("@/lib/secrets");
  check("buffer token decrypt round-trip", secrets().decrypt(((await db.socialSettings.findUnique({ where: { workspaceId: "ws-1" } })) as SRow).bufferTokenEnc as string) === "tok-123");
  const port = await getBufferPort(db, "ws-1", (t) => new MockBufferPort() as unknown as never);
  check("getBufferPort with token", port !== null);
  await revokeBufferToken(db, "ws-1");
  check("revokeBufferToken", !(await hasBufferToken(db, "ws-1")));
  check("getBufferPort no token → null", (await getBufferPort(db, "ws-1", () => { throw new Error("must not be called"); })) === null);
}

// --- createPost / updatePost / deletePost edges ------------------------------------
{
  const db = sDb(sState());
  let threw = "";
  try {
    await createPost(db, "ws-1", "proj-1", { content: sc(), services: ["myspace", "  "] });
  } catch (e) {
    threw = e instanceof Error ? e.message : "";
  }
  check("createPost unknown-only services blocked", /at least one/i.test(threw), threw);
  const p = (await createPost(db, "ws-1", "proj-1", { content: sc(), services: ["Twitter", "twitter", " X "] })) as SRow;
  check("createPost dedupes + normalizes services", JSON.stringify(p.services) === JSON.stringify(["twitter"]));
  const badDate = (await createPost(db, "ws-1", "proj-1", { content: sc(), services: ["twitter"], scheduledFor: "not-a-date" })) as SRow;
  check("BUG? createPost accepts invalid scheduledFor", (badDate.scheduledFor as Date).toString() !== "Invalid Date", String(badDate.scheduledFor));
  await updatePost(db, "ws-1", p.id as string, { content: sc({ text: "edited" }) });
  check("updatePost draft ok", true);
  // non-draft cannot be edited
  const stateU = sState();
  addChannel(stateU, "twitter");
  const dbU = sDb(stateU);
  const pu = addPost(stateU);
  await dispatchPost(dbU, "ws-1", "proj-1", pu.id as string, new MockBufferPort());
  let t3 = "";
  try {
    await updatePost(dbU, "ws-1", pu.id as string, { content: sc({ text: "x" }) });
  } catch (e) {
    t3 = e instanceof Error ? e.message : "";
  }
  check("updatePost non-draft blocked", /only drafts/i.test(t3), t3);
  let t4 = "";
  try {
    await deletePost(dbU, "ws-1", pu.id as string);
  } catch (e) {
    t4 = e instanceof Error ? e.message : "";
  }
  check("deletePost scheduled blocked", /cancel scheduled/i.test(t4), t4);
  const stateD = sState();
  const dbD = sDb(stateD);
  const pd = addPost(stateD);
  await deletePost(dbD, "ws-1", pd.id as string);
  check("deletePost draft works", !stateD.posts.has(pd.id as string));
  const pf = addPost(stateD, { status: "failed" });
  await deletePost(dbD, "ws-1", pf.id as string);
  check("deletePost failed works", !stateD.posts.has(pf.id as string));
}

// --- resolveTargetChannels -----------------------------------------------------------
{
  const state = sState();
  addChannel(state, "twitter", true);
  addChannel(state, "instagram", false);
  const db = sDb(state);
  const { channels, missing } = await resolveTargetChannels(db, "proj-1", ["twitter", "instagram", "tiktok"]);
  check("resolveTargetChannels finds enabled", channels.length === 1 && channels[0].service === "twitter");
  check("resolveTargetChannels missing disabled+absent", missing.length === 2);
  // duplicate channel rows for same service → first wins
  state.channels.set("ch-twitter-2", { id: "ch-twitter-2", projectId: "proj-1", bufferProfileId: "prof-twitter-2", service: "twitter", enabled: true });
  const r2 = await resolveTargetChannels(db, "proj-1", ["twitter"]);
  check("duplicate service rows first wins", r2.channels[0].bufferProfileId === "prof-twitter");
}

// --- dispatchPost: partial-failure — FIXED (day-1, edge #9) ---------------------------
// Update ids are persisted incrementally, so a retry after a mid-loop failure
// resumes without duplicating the already-created channel updates.
{
  const state = sState();
  addChannel(state, "twitter");
  addChannel(state, "linkedin");
  const row = addPost(state, { services: ["twitter", "linkedin"] });
  const db = sDb(state);
  // port fails ONLY on the 2nd createUpdate call
  const port = new MockBufferPort();
  let n = 0;
  const orig = port.createUpdate.bind(port);
  port.createUpdate = async (profileId: string, args: never) => {
    n += 1;
    if (n === 2) throw Object.assign(new Error("boom"), { status: 503 });
    return orig(profileId, args);
  };
  let threw = "";
  try {
    await dispatchPost(db, "ws-1", "proj-1", row.id as string, port);
  } catch (e) {
    threw = e instanceof Error ? e.message : "";
  }
  check("partial dispatch throws", /boom/.test(threw), threw);
  check("FIXED: channel A's update id persisted before channel B failed",
    (row.bufferUpdateIds as unknown[]).length === 1, `bufferUpdateIds=${JSON.stringify(row.bufferUpdateIds)}`);
  check("FIXED: claim released back to scheduled after failure", row.status === "scheduled", `status=${row.status}`);
  const createdAfterFail = port.created.length;
  // retry: channel A is skipped (already queued), only channel B is created
  await dispatchPost(db, "ws-1", "proj-1", row.id as string, port).catch(() => {});
  check("FIXED: retry after partial failure does not duplicate channel A",
    port.created.length === createdAfterFail + 1, `created=${port.created.length} after first-fail=${createdAfterFail}`);
  void createdAfterFail;
}

// --- attemptDispatch: always-failing mock — bounded attempts -----------------------------
{
  const state = sState();
  addChannel(state, "twitter");
  const row = addPost(state);
  const db = sDb(state);
  const port = new MockBufferPort();
  port.failNext(99, () => Object.assign(new Error("down"), { status: 503 }));
  let calls = 0;
  const origCu = port.createUpdate.bind(port);
  port.createUpdate = async (profileId: string, args: never) => {
    calls += 1;
    return origCu(profileId, args);
  };
  const outcomes: string[] = [];
  const backoffs: Array<Date | null> = [];
  for (let i = 0; i < 5; i++) {
    const a = await attemptDispatch(db, "ws-1", row as never, port, "system");
    outcomes.push(a.outcome);
    backoffs.push(row.nextAttemptAt as Date | null);
    if (a.outcome === "failed") break;
  }
  check("retry sequence retrying,retrying,failed", JSON.stringify(outcomes) === JSON.stringify(["retrying", "retrying", "failed"]), JSON.stringify(outcomes));
  check("exactly 3 provider attempts", calls === 3, `calls=${calls}`);
  check("backoff increasing then null", backoffs[0] instanceof Date && backoffs[1] instanceof Date && (backoffs[1] as Date).getTime() > (backoffs[0] as Date).getTime() && backoffs[2] === null);
  check("error recorded at cap", typeof row.error === "string" && row.error.length > 0);
}

// --- cron overlap: two concurrent sweeps -------------------------------------------------
{
  const state = sState();
  addChannel(state, "twitter");
  addPost(state, { status: "scheduled", scheduledFor: new Date(Date.now() - 1000) });
  const db = sDb(state);
  const mkPort = () => {
    const p = new MockBufferPort();
    const orig = p.createUpdate.bind(p);
    p.createUpdate = async (profileId: string, args: never) => {
      await new Promise((r) => setTimeout(r, 30));
      return orig(profileId, args);
    };
    return p;
  };
  const port = mkPort();
  const [s1, s2] = await Promise.all([
    runDueSocialPosts(db, async () => port, "ws-1"),
    runDueSocialPosts(db, async () => port, "ws-1"),
  ]);
  check("FIXED: concurrent sweeps dispatch exactly once", port.created.length === 1, `created=${port.created.length} s1=${JSON.stringify(s1)} s2=${JSON.stringify(s2)}`);
  const loser = s1.dispatched === 0 ? s1 : s2;
  check("FIXED: losing sweep skips benignly (no failure, no retry)",
    loser.dispatched === 0 && loser.failed === 0 && loser.retrying === 0,
    `loser=${JSON.stringify(loser)}`);
}

// --- cron: no port / future / refresh path --------------------------------------------------
{
  const state = sState();
  addChannel(state, "twitter");
  addPost(state, { status: "scheduled", scheduledFor: new Date(Date.now() - 1000) });
  addPost(state, { status: "scheduled", scheduledFor: new Date(Date.now() + 3600_000) });
  const db = sDb(state);
  const r = await runDueSocialPosts(db, async () => null, "ws-1");
  check("cron no port → skipped silently", r.dispatched === 0 && r.failed === 0, JSON.stringify(r));
  check("cron future post untouched", (state.posts.get("post-2") as SRow).status === "scheduled");

  // refresh path: dispatched, due, all sent → markedSent
  const state2 = sState();
  addChannel(state2, "twitter");
  const port = new MockBufferPort();
  const db2 = sDb(state2);
  const row = addPost(state2, { status: "scheduled", scheduledFor: new Date(Date.now() - 1000) });
  await dispatchPost(db2, "ws-1", "proj-1", row.id as string, port);
  port.advance();
  const r2 = await runDueSocialPosts(db2, async () => port, "ws-1");
  check("cron marks sent", r2.markedSent === 1, JSON.stringify(r2));
}

// --- cancel / refresh / analytics edges ------------------------------------------------------
{
  const state = sState();
  addChannel(state, "twitter");
  const db = sDb(state);
  const row = addPost(state);
  let threw = "";
  try {
    await cancelPost(db, "ws-1", row.id as string, null);
  } catch (e) {
    threw = e instanceof Error ? e.message : "";
  }
  check("cancelPost draft blocked", /only scheduled or failed/i.test(threw), threw);
  const port = new MockBufferPort();
  await dispatchPost(db, "ws-1", "proj-1", row.id as string, port);
  await cancelPost(db, "ws-1", row.id as string, null);
  check("cancelPost without port still cancels", row.status === "cancelled" && port.deleted.length === 0);

  // refresh with failing lookups → no crash
  const state2 = sState();
  addChannel(state2, "twitter");
  const db2 = sDb(state2);
  const row2 = addPost(state2, { status: "scheduled", bufferUpdateIds: [{ channelId: "c", profileId: "p", updateId: "u1", service: "twitter" }] });
  const badPort = new MockBufferPort();
  badPort.failNext(5, () => new Error("lookup down"));
  const ref = await refreshPostStatus(db2, "ws-1", row2.id as string, badPort);
  check("refreshPostStatus lookup failure no-crash", ref.sentCount === 0 && row2.status === "scheduled");

  // analytics with failing lookups → zeros, persisted
  const ana = await syncAnalytics(db2, "ws-1", row2.id as string, badPort);
  check("syncAnalytics failure → zero totals", (ana as { totals: Record<string, number> }).totals.likes === 0);
  check("syncAnalytics persisted", (row2.stats as { totals: Record<string, number> }).totals.clicks === 0);
}

console.log(`[social-service] done`);

// ===========================================================================
// 7. ads/brief.ts — prompt builder, fan-out, validation
// ===========================================================================
section = "ads-brief";

import {
  ASPECT_RATIOS,
  MAX_VARIANTS,
  buildAdPrompt,
  estimateCostCents,
  fanOutVariants,
  recommendedRatios,
  validateBrief,
  type AdBrief,
  type BrandConstraints,
} from "@/lib/ads/brief";
import { MockHiggsfieldPort, isTransientHiggsfieldError } from "@/lib/ads/higgsfield";
import {
  AdGuardError,
  MAX_POLL_ATTEMPTS,
  approveCreative,
  cancelCreative,
  checkCap,
  currentPeriod,
  generateCreatives,
  getCampaignSpend,
  getHiggsfieldPort,
  getSpendSummary,
  pollCreative,
  regenerateCreative,
  rejectCreative,
  revokeHiggsfieldKey,
  runDueAdJobs,
  sendCreativeToSocial,
  setHiggsfieldKey,
  submitJob,
  updateSpendCap,
} from "@/lib/ads/service";

const brief: AdBrief = {
  product: "Marketr SEO workspace",
  audience: "Agency owners",
  hook: "Reports write themselves",
  offer: "14-day trial",
  cta: "Start free",
  tone: "bold",
  negativePrompt: "cartoonish",
};
const brand: BrandConstraints = {
  colors: { primary: "#0ea5e9", text: "#18181b" },
  fonts: { heading: "Inter", body: "Inter" },
  tone: "confident",
  hasLogo: true,
};

{
  const neg = buildAdPrompt(brief, brand, "image", "1:1", -1);
  check("BUG? negative variantIndex → undefined angle", !neg.prompt.includes("undefined"), neg.prompt.slice(neg.prompt.indexOf("Creative angle"), neg.prompt.indexOf("Creative angle") + 60));
  const wrap = buildAdPrompt(brief, brand, "image", "1:1", 7);
  const v1 = buildAdPrompt(brief, brand, "image", "1:1", 1);
  check("variantIndex wraps modulo 6", wrap.prompt === v1.prompt);
  const big = buildAdPrompt(brief, brand, "image", "1:1", 1_000_003);
  check("huge variantIndex wraps", big.prompt === buildAdPrompt(brief, brand, "image", "1:1", 1_000_003 % 6).prompt);

  check("BUG? fanOutVariants(NaN) → []", fanOutVariants(brief, brand, "image", "1:1", NaN).length >= 1, `length=${fanOutVariants(brief, brand, "image", "1:1", NaN).length}`);
  check("fanOutVariants(-3) → 1", fanOutVariants(brief, brand, "image", "1:1", -3).length === 1);
  check("fanOutVariants(2.7) → 2", fanOutVariants(brief, brand, "image", "1:1", 2.7).length === 2);
  check("fanOutVariants clamps to MAX_VARIANTS", fanOutVariants(brief, brand, "image", "1:1", 99).length === MAX_VARIANTS);

  let crashed = "";
  try {
    validateBrief({ product: 123, audience: "a", hook: "h", cta: "c" } as unknown as Partial<AdBrief>);
  } catch (e) {
    crashed = e instanceof Error ? e.message : "";
  }
  check("BUG? validateBrief crashes on non-string", crashed === "", crashed);
  { const r = (() => { try { return validateBrief(null as unknown as Partial<AdBrief>); } catch (e) { return e instanceof Error ? "CRASH:" + e.message : "CRASH"; } })(); check("BUG? validateBrief null brief", Array.isArray(r), String(r)); };
  check("validateBrief 500-char product ok", validateBrief({ product: "p".repeat(500), audience: "a", hook: "h", cta: "c" }).length === 0);
  check("validateBrief 501-char product flagged", validateBrief({ product: "p".repeat(501), audience: "a", hook: "h", cta: "c" }).length === 1);
  check("validateBrief hook/audience/cta length unchecked (100k hook ok)", validateBrief({ product: "p", audience: "a", hook: "h".repeat(100_000), cta: "c" }).length === 0);

  const emptyBrand: BrandConstraints = { colors: {}, fonts: {}, tone: null, hasLogo: false };
  const eb = buildAdPrompt({ ...brief, tone: undefined }, emptyBrand, "image", "1:1", 0);
  check("empty brand → no palette lines, default tone", !eb.prompt.includes("Brand palette") && !eb.prompt.includes("Typography style") && eb.prompt.includes("confident, modern"));
  const uni = buildAdPrompt({ ...brief, product: "מוצר 🌍", hook: "שלום", cta: "התחל" }, brand, "image", "9:16", 0);
  check("unicode brief preserved", uni.prompt.includes("מוצר 🌍") && uni.prompt.includes("שלום"));

  check("recommendedRatios([]) fallback", JSON.stringify(recommendedRatios([])) === JSON.stringify(["1:1"]));
  check("recommendedRatios dedupes", JSON.stringify(recommendedRatios(["tiktok", "youtube"])) === JSON.stringify(["9:16", "16:9"]));
  check("aspect ratios count", Object.keys(ASPECT_RATIOS).length === 4);
  check("estimateCostCents zero variants", estimateCostCents("image", 0) === 0);
}

console.log(`[ads-brief] done`);

// ===========================================================================
// 8. ads/higgsfield.ts — error classification, mock port
// ===========================================================================
section = "ads-higgsfield";

{
  check("429 transient", isTransientHiggsfieldError({ status: 429 }));
  check("500 transient", isTransientHiggsfieldError({ status: 500 }));
  check("503 transient", isTransientHiggsfieldError(Object.assign(new Error("x"), { status: 503 })));
  check("400 permanent", !isTransientHiggsfieldError({ status: 400 }));
  check("404 permanent", !isTransientHiggsfieldError({ status: 404 }));
  check("401 permanent", !isTransientHiggsfieldError({ status: 401 }));
  check("TypeError transient", isTransientHiggsfieldError(new TypeError("fetch failed")));
  const plainVsBuffer = isTransientHiggsfieldError(new Error("socket hangup"));
  check("NOTE plain Error non-transient (differs from Buffer port)", plainVsBuffer === false, `higgsfield=${plainVsBuffer} vs buffer=${isTransientBufferError(new Error("socket hangup"))}`);
  check("undefined → false", !isTransientHiggsfieldError(undefined));
  check("null → false", !isTransientHiggsfieldError(null));

  // mock: scriptNext twice without submit → second overwrites first
  const port = new MockHiggsfieldPort();
  port.scriptNext(["failed"], [], "first-script");
  port.scriptNext(["in_progress", "completed"], ["https://cdn/x.mp4"]);
  const sub = await port.submitJob({ modelPath: "m", args: {} });
  const s1 = await port.getStatus(sub.requestId);
  check("BUG? mock scriptNext overwrite", s1.state === "failed" && s1.error === "first-script", `state=${s1.state} error=${s1.error}`);

  const port2 = new MockHiggsfieldPort();
  const sub2 = await port2.submitJob({ modelPath: "m", args: {} });
  check("mock default two-poll completion", (await port2.getStatus(sub2.requestId)).state === "in_progress" && (await port2.getStatus(sub2.requestId)).state === "completed");
  const s3 = await port2.getStatus(sub2.requestId);
  check("mock exhausted script → completed", s3.state === "completed");
  const unknown = await port2.getStatus("never-submitted");
  check("NOTE mock unknown id → completed", unknown.state === "completed" && unknown.mediaUrls.length === 0);
  check("mock submit records args", port2.getSubmitted().length === 1 && (port2.getSubmitted()[0].args as Record<string, unknown>) !== undefined);
}

console.log(`[ads-higgsfield] done`);

// ===========================================================================
// 9. ads/service.ts — caps, submit/poll state machine, review guards, cron
// ===========================================================================
section = "ads-service";

interface ARow { [k: string]: unknown }
interface AState {
  settings: ARow | null;
  campaigns: Map<string, ARow>;
  creatives: Map<string, ARow>;
  audit: ARow[];
  socialPosts: ARow[];
}
let aSeq = 0;
function aState(): AState {
  return {
    settings: { workspaceId: "ws-1", monthlyCapCents: 5000, spendCents: 0, spendPeriod: currentPeriod() },
    campaigns: new Map([["camp-1", { id: "camp-1", projectId: "proj-1", name: "Launch", brandKitId: "kit-1", channels: ["instagram"] }]]),
    creatives: new Map(),
    audit: [],
    socialPosts: [],
  };
}
function aDb(state: AState) {
  return {
    adSettings: {
      findUnique: async () => state.settings,
      upsert: async ({ create, update }: { create: ARow; update: ARow }) => {
        state.settings = { ...(state.settings ?? {}), ...create, ...update };
        return state.settings;
      },
      update: async ({ data }: { data: ARow }) => {
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === "object" && "increment" in (v as object)) (state.settings![k] as number) += (v as { increment: number }).increment;
          else state.settings![k] = v;
        }
        return state.settings;
      },
    },
    adCampaign: {
      findUnique: async ({ where }: { where: { id: string } }) => state.campaigns.get(where.id) ?? null,
      create: async ({ data }: { data: ARow }) => {
        const row = { id: `camp-${state.campaigns.size + 1}`, ...data };
        state.campaigns.set(row.id as string, row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: ARow }) => {
        const row = state.campaigns.get(where.id)!;
        Object.assign(row, data);
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => { state.campaigns.delete(where.id); },
    },
    adCreative: {
      create: async ({ data }: { data: ARow }) => {
        aSeq += 1;
        const row: ARow = { id: `cr-${aSeq}`, attempts: 0, assets: [], costActualCents: 0, error: null, approved: false, rejected: false, promptHistory: [], providerJobId: null, nextPollAt: null, status: "queued", ...data };
        state.creatives.set(row.id as string, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => state.creatives.get(where.id) ?? null,
      findMany: async ({ where, take }: { where?: ARow; take?: number }) => {
        let rows = [...state.creatives.values()];
        if (where?.status && (where.status as ARow).in) rows = rows.filter((r) => ((where.status as ARow).in as string[]).includes(r.status as string));
        if (where?.nextPollAt && (where.nextPollAt as ARow).lte) rows = rows.filter((r) => !!r.nextPollAt && (r.nextPollAt as Date) <= ((where.nextPollAt as ARow).lte as Date));
        // snapshot copies, like a real read
        rows = rows.map((r) => ({ ...r, campaign: { id: r.campaignId, projectId: r.projectId, project: { workspaceId: "ws-1" } } }));
        return rows.slice(0, take ?? rows.length);
      },
      update: async ({ where, data }: { where: { id: string }; data: ARow }) => {
        const row = state.creatives.get(where.id)!;
        Object.assign(row, data);
        return row;
      },
      // Day-1 (edge #11): atomic submit claim support.
      updateMany: async ({ where, data }: { where: ARow; data: ARow }) => {
        let count = 0;
        for (const r of state.creatives.values()) {
          if ((where as { id?: string }).id !== undefined && r.id !== (where as { id: string }).id) continue;
          const st = (where as { status?: string | { in?: string[] } }).status;
          if (typeof st === "string") { if (r.status !== st) continue; }
          else if (st?.in && !(st.in as string[]).includes(r.status as string)) continue;
          Object.assign(r, data);
          count++;
        }
        return { count };
      },
      aggregate: async () => {
        const rows = [...state.creatives.values()];
        return { _sum: { costEstimateCents: rows.reduce((s, r) => s + ((r.costEstimateCents as number) ?? 0), 0), costActualCents: rows.reduce((s, r) => s + ((r.costActualCents as number) ?? 0), 0) }, _count: rows.length };
      },
    },
    brandKit: { findUnique: async () => ({ id: "kit-1", colors: { primary: "#0ea5e9" }, fonts: { heading: "Inter" }, tone: "bold", logoPath: "logos/k.png" }) },
    fileChangeLog: { create: async ({ data }: { data: ARow }) => { state.audit.push(data); return data; } },
    socialPost: { create: async ({ data }: { data: ARow }) => { const row = { id: `sp-${state.socialPosts.length + 1}`, ...data }; state.socialPosts.push(row); return row; } },
  } as unknown as PrismaClient;
}

// --- settings / cap edges ----------------------------------------------------------
{
  const db = aDb(aState());
  for (const bad of ["", "   "]) {
    let threw = false;
    try {
      await setHiggsfieldKey(db, "ws-1", bad);
    } catch (e) {
      threw = e instanceof AdGuardError;
    }
    check(`setHiggsfieldKey rejects ${JSON.stringify(bad)}`, threw);
  }
  const { secrets } = await import("@/lib/secrets");
  await setHiggsfieldKey(db, "ws-1", "KEY:SECRET");
  check("higgsfield key round-trip", secrets().decrypt(((await db.adSettings.findUnique({ where: { workspaceId: "ws-1" } })) as ARow).higgsfieldKeyEnc as string) === "KEY:SECRET");
  check("getHiggsfieldPort with key", (await getHiggsfieldPort(db, "ws-1", () => ({} as never))) !== null);
  await revokeHiggsfieldKey(db, "ws-1");
  check("getHiggsfieldPort revoked → null", (await getHiggsfieldPort(db, "ws-1", () => { throw new Error("must not be called"); })) === null);

  for (const bad of [-1, NaN, Infinity]) {
    let threw = false;
    try {
      await updateSpendCap(db, "ws-1", bad);
    } catch (e) {
      threw = e instanceof AdGuardError;
    }
    check(`updateSpendCap rejects ${String(bad)}`, threw);
  }
  await updateSpendCap(db, "ws-1", 10.9);
  check("updateSpendCap floors", ((await db.adSettings.findUnique({ where: { workspaceId: "ws-1" } })) as ARow).monthlyCapCents === 10);

  const db2 = aDb(aState());
  (db2 as unknown as { adSettings: { findUnique: () => Promise<null> } });
  const dbNo = { adSettings: { findUnique: async () => null, update: async () => null, upsert: async () => null } } as unknown as PrismaClient;
  const sum = await getSpendSummary(dbNo, "ws-1");
  check("spend summary defaults (no settings)", sum.capCents === 5000 && sum.spendCents === 0 && !sum.atCap && sum.remainingCents === 5000);

  // cap boundary: spend 5000/5000, additional 0 allowed, 1 blocked
  const st = aState();
  st.settings!.spendCents = 5000;
  st.settings!.monthlyCapCents = 5000;
  const db3 = aDb(st);
  await checkCap(db3, "ws-1", 0);
  check("cap exactly-at-limit + 0 allowed", true);
  let threw = false;
  try {
    await checkCap(db3, "ws-1", 1);
  } catch (e) {
    threw = e instanceof AdGuardError;
  }
  check("cap one-over blocked", threw);

  // period rollover resets spend
  const st4 = aState();
  st4.settings!.spendPeriod = "2000-01";
  st4.settings!.spendCents = 4999;
  const db4 = aDb(st4);
  const sum4 = await getSpendSummary(db4, "ws-1");
  check("period rollover resets spend", sum4.spendCents === 0 && sum4.period === currentPeriod());
  check("currentPeriod format", /^\d{4}-\d{2}$/.test(currentPeriod()));
}

// --- generateCreatives edges ---------------------------------------------------------
{
  const db = aDb(aState());
  const port = new MockHiggsfieldPort();
  const nan = await generateCreatives(db, "ws-1", "proj-1", "camp-1", { brief, type: "image", aspectRatio: "1:1", variants: NaN }, port);
  check("BUG? generateCreatives(NaN) silent no-op", nan.created >= 1, `created=${nan.created}`);
  const zero = await generateCreatives(db, "ws-1", "proj-1", "camp-1", { brief, type: "image", aspectRatio: "1:1", variants: 0 }, port);
  check("generateCreatives(0) → 1", zero.created === 1);
  const frac = await generateCreatives(db, "ws-1", "proj-1", "camp-1", { brief, type: "image", aspectRatio: "1:1", variants: 2.9 }, port);
  check("generateCreatives(2.9) → 2", frac.created === 2);
  let threw = false;
  try {
    await generateCreatives(db, "ws-1", "WRONG", "camp-1", { brief, type: "image", aspectRatio: "1:1", variants: 1 }, port);
  } catch (e) {
    threw = e instanceof AdGuardError;
  }
  check("generateCreatives project mismatch blocked", threw);
  // campaign name duplicated → allowed (no uniqueness)
  await db.adCampaign.create({ data: { projectId: "proj-1", name: "Launch", brandKitId: "kit-1", channels: [] } });
  check("duplicate campaign names allowed", true);
}

// --- submitJob retry exhaustion + idempotency --------------------------------------------
{
  const state = aState();
  const db = aDb(state);
  const port = new MockHiggsfieldPort();
  const { creativeIds } = await generateCreatives(db, "ws-1", "proj-1", "camp-1", { brief, type: "image", aspectRatio: "1:1", variants: 1 }, port);
  const id = creativeIds[0];
  // force back to queued without a job for submit-retry testing
  const row = state.creatives.get(id)!;
  row.status = "queued";
  row.providerJobId = null;
  row.attempts = 0;

  const failPort = {
    calls: 0,
    async submitJob() {
      this.calls += 1;
      throw Object.assign(new Error("svc down"), { status: 503 });
    },
    async getStatus() { throw new Error("unused"); },
  };
  const o1 = await submitJob(db, "ws-1", id, failPort as never, { modelPath: "m" });
  const o2 = await submitJob(db, "ws-1", id, failPort as never, { modelPath: "m" });
  const o3 = await submitJob(db, "ws-1", id, failPort as never, { modelPath: "m" });
  check("submit retry sequence", o1.outcome === "retrying" && o2.outcome === "retrying" && o3.outcome === "failed", `${o1.outcome},${o2.outcome},${o3.outcome}`);
  check("submit exactly 3 provider calls", failPort.calls === 3, `calls=${failPort.calls}`);
  const r3 = state.creatives.get(id)!;
  check("submit cap: failed + no next poll", r3.status === "failed" && r3.nextPollAt === null && r3.attempts === 3);
  check("submit failure audited", state.audit.some((a) => a.action === "ad_generation_failed"));

  const permPort = {
    async submitJob() { throw Object.assign(new Error("bad request"), { status: 400 }); },
    async getStatus() { throw new Error("unused"); },
  };
  const state2 = aState();
  const db2 = aDb(state2);
  const port2 = new MockHiggsfieldPort();
  const g2 = await generateCreatives(db2, "ws-1", "proj-1", "camp-1", { brief, type: "image", aspectRatio: "1:1", variants: 1 }, port2);
  const id2 = g2.creativeIds[0];
  const r2row = state2.creatives.get(id2)!;
  r2row.status = "queued"; r2row.providerJobId = null; r2row.attempts = 0;
  const op = await submitJob(db2, "ws-1", id2, permPort as never, { modelPath: "m" });
  check("submit permanent → failed immediately", op.outcome === "failed" && r2row.attempts === 1);
}

// --- stuck creative: generating without providerJobId ---------------------------------------
{
  const state = aState();
  const db = aDb(state);
  const port = new MockHiggsfieldPort();
  const { creativeIds } = await generateCreatives(db, "ws-1", "proj-1", "camp-1", { brief, type: "image", aspectRatio: "1:1", variants: 1 }, port);
  const id = creativeIds[0];
  const row = state.creatives.get(id)!;
  row.providerJobId = null; // simulate crash between provider submit and row update
  const s = await submitJob(db, "ws-1", id, port, { modelPath: "m" });
  check("stuck generating/no-job → noop", s.outcome === "noop");
  const p = await pollCreative(db, "ws-1", id, port);
  check("stuck creative poll → no-job", p.outcome === "no-job");
  row.nextPollAt = new Date(Date.now() - 1000);
  const sweep = await runDueAdJobs(db, async () => port);
  check("BUG? stuck creative polled forever", sweep.pending === 0, `sweep=${JSON.stringify(sweep)}`);
}

// --- pollCreative boundaries ------------------------------------------------------------------
{
  const state = aState();
  const db = aDb(state);
  const port = new MockHiggsfieldPort();
  const { creativeIds } = await generateCreatives(db, "ws-1", "proj-1", "camp-1", { brief, type: "image", aspectRatio: "1:1", variants: 1 }, port);
  const id = creativeIds[0];
  const row = state.creatives.get(id)!;
  row.attempts = MAX_POLL_ATTEMPTS;
  const p = await pollCreative(db, "ws-1", id, port);
  check("poll at MAX_POLL_ATTEMPTS → failed", p.outcome === "failed" && row.status === "failed", p.outcome);
  check("poll timeout message", /timed out/i.test((row.error as string) ?? ""));

  // cancelled provider state → failed
  const state2 = aState();
  const db2 = aDb(state2);
  const port2 = new MockHiggsfieldPort();
  port2.scriptNext(["cancelled"], [], "user cancelled at provider");
  const g2 = await generateCreatives(db2, "ws-1", "proj-1", "camp-1", { brief, type: "image", aspectRatio: "1:1", variants: 1 }, port2);
  const id2 = g2.creativeIds[0];
  const p2 = await pollCreative(db2, "ws-1", id2, port2);
  check("provider cancelled → failed", p2.outcome === "failed" && (state2.creatives.get(id2)!.status as string) === "failed");

  // completed with zero media → ready with empty assets; zero cost → no spend
  const state3 = aState();
  const db3 = aDb(state3);
  const port3 = new MockHiggsfieldPort();
  port3.scriptNext(["completed"], [], undefined);
  const g3 = await generateCreatives(db3, "ws-1", "proj-1", "camp-1", { brief, type: "image", aspectRatio: "1:1", variants: 1 }, port3);
  const id3 = g3.creativeIds[0];
  const p3 = await pollCreative(db3, "ws-1", id3, port3);
  const r3 = state3.creatives.get(id3)!;
  check("completed w/o media → ready, empty assets", p3.outcome === "ready" && (r3.assets as unknown[]).length === 0);
  check("zero-cost completion → no spend", (state3.settings!.spendCents as number) === 0 && (r3.costActualCents as number) === 0);

  // poll missing creative → throws
  let threw = false;
  try {
    await pollCreative(db3, "ws-1", "missing", port3);
  } catch (e) {
    threw = e instanceof AdGuardError;
  }
  check("pollCreative missing throws AdGuardError", threw);
}

// --- review guards --------------------------------------------------------------------------------
{
  const state = aState();
  const db = aDb(state);
  const port = new MockHiggsfieldPort();
  const { creativeIds } = await generateCreatives(db, "ws-1", "proj-1", "camp-1", { brief, type: "image", aspectRatio: "1:1", variants: 1 }, port);
  const id = creativeIds[0];

  // reject a still-generating creative: allowed, but the job keeps running
  const rej = await rejectCreative(db, "ws-1", id);
  check("rejectCreative on generating allowed", (rej as ARow).rejected === true);
  await pollCreative(db, "ws-1", id, port);
  await pollCreative(db, "ws-1", id, port);
  const row = state.creatives.get(id)!;
  check("NOTE rejected creative still completes (spend continues)", row.status === "ready" && row.rejected === true);

  // approve after reject works
  const ap = await approveCreative(db, "ws-1", id);
  check("approve after reject works", (ap as ARow).approved === true && (ap as ARow).rejected === false);

  // cancel guards
  let t1 = "";
  try {
    await cancelCreative(db, "ws-1", id);
  } catch (e) {
    t1 = e instanceof Error ? e.message : "";
  }
  check("cancelCreative ready blocked", /cannot be cancelled/i.test(t1), t1);
  const { creativeIds: ids2 } = await generateCreatives(db, "ws-1", "proj-1", "camp-1", { brief, type: "image", aspectRatio: "1:1", variants: 1 }, port);
  await cancelCreative(db, "ws-1", ids2[0]);
  check("cancelCreative queued works", (state.creatives.get(ids2[0])!.status as string) === "cancelled");
  const polled = await pollCreative(db, "ws-1", ids2[0], port);
  check("pollCreative cancelled → noop", polled.outcome === "noop");

  // regenerate guards + history growth
  let t2 = "";
  const { creativeIds: ids3 } = await generateCreatives(db, "ws-1", "proj-1", "camp-1", { brief, type: "image", aspectRatio: "1:1", variants: 1 }, port);
  try {
    await regenerateCreative(db, "ws-1", ids3[0], { port });
  } catch (e) {
    t2 = e instanceof Error ? e.message : "";
  }
  check("regenerateCreative generating blocked", /still generating/i.test(t2), t2);
  await pollCreative(db, "ws-1", ids3[0], port);
  await pollCreative(db, "ws-1", ids3[0], port);
  await regenerateCreative(db, "ws-1", ids3[0], { prompt: "v2", port });
  await pollCreative(db, "ws-1", ids3[0], port);
  await pollCreative(db, "ws-1", ids3[0], port);
  await regenerateCreative(db, "ws-1", ids3[0], { prompt: "v3", port });
  check("regenerate history grows", ((state.creatives.get(ids3[0])!.promptHistory as unknown[]).length as number) === 2);
  // regenerate blocked by cap
  const st = aState();
  st.settings!.monthlyCapCents = 0;
  const dbCap = aDb(st);
  const portC = new MockHiggsfieldPort();
  const gc = await generateCreatives(dbCap, "ws-1", "proj-1", "camp-1", { brief, type: "image", aspectRatio: "1:1", variants: 1 }, portC).catch(() => null);
  void gc;
  check("regen cap gate (setup: generation blocked at cap 0)", gc === null);
}

// --- sendCreativeToSocial guards (Wave B: Postiz drafts, draft-first) ------------------------------------
// Stub the Postiz sidecar: URL-aware — uploads return { id, path }, posts return a draft id.
let capturedPostizBody: Record<string, unknown> | null = null;
{
  const g = globalThis as unknown as { fetch: typeof fetch };
  g.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).includes("/upload-from-url")) {
      return { ok: true, json: async () => ({ id: "upl_1", path: "https://uploads.postiz.com/upl_1.png" }) } as Response;
    }
    capturedPostizBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return { ok: true, json: async () => ({ id: "draft_456" }) } as Response;
  }) as typeof fetch;
  process.env.POSTIZ_URL = "https://postiz.example.com";
  process.env.POSTIZ_API_KEY = "test-key";
}
{
  const state = aState();
  const db = aDb(state);
  const port = new MockHiggsfieldPort();
  const { creativeIds } = await generateCreatives(db, "ws-1", "proj-1", "camp-1", { brief, type: "image", aspectRatio: "1:1", variants: 1 }, port);
  const id = creativeIds[0];
  await pollCreative(db, "ws-1", id, port);
  await pollCreative(db, "ws-1", id, port);
  await approveCreative(db, "ws-1", id);

  let t1 = "";
  try {
    await sendCreativeToSocial(db, "ws-1", "proj-1", id, { text: "   ", channelIds: ["ch_1"] });
  } catch (e) {
    t1 = e instanceof Error ? e.message : "";
  }
  check("sendCreativeToSocial blank text blocked", /text is required/i.test(t1), t1);
  let t2 = "";
  try {
    await sendCreativeToSocial(db, "ws-1", "OTHER", id, { text: "hi", channelIds: ["ch_1"] });
  } catch (e) {
    t2 = e instanceof Error ? e.message : "";
  }
  check("sendCreativeToSocial wrong project blocked", /not found/i.test(t2), t2);
  let t3 = "";
  try {
    await sendCreativeToSocial(db, "ws-1", "proj-1", id, { text: "hi", channelIds: [] });
  } catch (e) {
    t3 = e instanceof Error ? e.message : "";
  }
  check("sendCreativeToSocial no channels blocked", /at least one/i.test(t3), t3);
  const draft = await sendCreativeToSocial(db, "ws-1", "proj-1", id, { text: "Launch!", channelIds: ["ch_1"] });
  check("sendCreativeToSocial queues draft", typeof draft.postizRef === "string" && draft.postizRef.length > 0);
  check("sendCreativeToSocial draft-first", (capturedPostizBody as Record<string, unknown> | null)?.type === "draft");
  const emImages = (
    ((capturedPostizBody as Record<string, unknown> | null)?.posts as Array<{
      value: Array<{ image: Array<{ path: string }> }>;
    }>)?.[0]?.value[0].image ?? []
  );
  check("sendCreativeToSocial attaches creative media", emImages.length === 1 && emImages[0].path.includes("uploads.postiz.com"));
}

// --- cron overlap: two concurrent sweeps --------------------------------------------------------------
{
  const state = aState();
  const db = aDb(state);
  const mkPort = () => {
    const p = new MockHiggsfieldPort();
    const orig = p.submitJob.bind(p);
    p.submitJob = async (job: never) => {
      await new Promise((r) => setTimeout(r, 30));
      return orig(job);
    };
    return p;
  };
  const port = mkPort();
  state.creatives.set("cr-stuck", {
    id: "cr-stuck", campaignId: "camp-1", projectId: "proj-1", name: "stuck", type: "image",
    brief: {}, prompt: "p", promptHistory: [], status: "queued", aspectRatio: "1:1", channels: [],
    costEstimateCents: 50, costActualCents: 0, assets: [], providerJobId: null,
    attempts: 0, nextPollAt: new Date(Date.now() - 1000), error: null, approved: false, rejected: false,
  });
  const [s1, s2] = await Promise.all([
    runDueAdJobs(db, async () => port),
    runDueAdJobs(db, async () => port),
  ]);
  check("FIXED: concurrent ad sweeps submit exactly once", port.getSubmitted().length === 1, `submitted=${port.getSubmitted().length} s1=${JSON.stringify(s1)} s2=${JSON.stringify(s2)}`);
  check("FIXED: losing ad sweep noops instead of double-submitting",
    (s1.submitted === 1 && s2.submitted === 0) || (s2.submitted === 1 && s1.submitted === 0),
    `s1=${JSON.stringify(s1)} s2=${JSON.stringify(s2)}`);
}

// --- pre-ack provider failure: claim released back to queued (FIXED day-1) ---
{
  const state = aState();
  const db = aDb(state);
  const port = new MockHiggsfieldPort();
  let calls = 0;
  const orig = port.submitJob.bind(port);
  port.submitJob = async (job: never) => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("provider down"), { status: 503 });
    return orig(job);
  };
  state.creatives.set("cr-preack", {
    id: "cr-preack", campaignId: "camp-1", projectId: "proj-1", name: "preack", type: "image",
    brief: {}, prompt: "p", promptHistory: [], status: "queued", aspectRatio: "1:1", channels: [],
    costEstimateCents: 50, costActualCents: 0, assets: [], providerJobId: null,
    attempts: 0, nextPollAt: new Date(Date.now() - 1000), error: null, approved: false, rejected: false,
  });
  const s1 = await runDueAdJobs(db, async () => port);
  const row = state.creatives.get("cr-preack") as ARow;
  check("FIXED: pre-ack failure releases claim to queued", row.status === "queued", `status=${row.status}`);
  check("FIXED: pre-ack failure sends nothing billable", port.getSubmitted().length === 0, `submitted=${port.getSubmitted().length}`);
  check("FIXED: pre-ack failure schedules retry", row.attempts === 1 && row.nextPollAt instanceof Date, `attempts=${row.attempts}`);
  check("pre-ack failure counted pending, not failed", s1.failed === 0, JSON.stringify(s1));
  // retry after backoff: submits exactly once
  (row as ARow).nextPollAt = new Date(Date.now() - 1000);
  const s2 = await runDueAdJobs(db, async () => port);
  check("FIXED: retry after pre-ack failure submits once", port.getSubmitted().length === 1 && s2.submitted === 1,
    `submitted=${port.getSubmitted().length} s2=${JSON.stringify(s2)}`);
}

// --- campaign spend rollup -------------------------------------------------------------------------------
{
  const state = aState();
  const db = aDb(state);
  const empty = await getCampaignSpend(db, "camp-1");
  check("campaign spend empty → zeros", empty.estimated === 0 && empty.actual === 0 && empty.count === 0);
}

console.log(`[ads-service] done`);

// ===========================================================================
// summary
// ===========================================================================
console.log("\n--- per-module ---");
for (const [mod, c] of Object.entries(sectionCounts)) {
  console.log(`${mod}: ${c.p + c.f} checks, ${c.p} passed, ${c.f} failed`);
}
console.log(`\nTOTAL: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
