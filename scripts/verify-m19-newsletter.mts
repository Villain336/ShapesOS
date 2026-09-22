// Marketr milestone 19 — fixture tests for the newsletter builder.
// Pure engine + mock Resend port + mock-db service paths: no live DB,
// no network, no Resend calls, no spend.
// Tests: block model/normalization, Tiptap→react-email→HTML rendering
// (structure, unsubscribe injection, brand application), guardrails,
// subscriber CSV import, and the sendBroadcast guardrail path.
// Run: npx tsx scripts/verify-m19-newsletter.mts

import {
  attr,
  blockLabel,
  brandFromKit,
  checkBroadcastGuardrails,
  createBlock,
  DEFAULT_BRAND,
  docHasUnsubscribe,
  docWordCount,
  EMAIL_BLOCK_TYPES,
  ensureUnsubscribe,
  isValidEmail,
  mapSubscriberColumns,
  normalizeDoc,
  parseSubscriberCsv,
  SUBSCRIBER_CSV_CAP,
  textLines,
  unsubscribeUrlFor,
  type EmailTiptapDoc,
} from "@/lib/newsletter/blocks";
import { renderNewsletter } from "@/lib/newsletter/render";
import { dmarcRecordFor, MockResendPort } from "@/lib/newsletter/resend";
import { STARTER_TEMPLATES } from "@/lib/newsletter/starters";
import { sendBroadcast, handleResendWebhook } from "@/lib/newsletter/service";
import type { PrismaClient } from "@prisma/client";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const BASE = "https://news.example.com";

function sampleDoc(): EmailTiptapDoc {
  return {
    type: "doc",
    content: [
      { type: "emailHeader", attrs: { tagline: "Weekly" } },
      { type: "emailHero", attrs: { title: "Hello world", subtitle: "Sub" } },
      {
        type: "emailText",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Bold and " },
              { type: "text", text: "linked", marks: [{ type: "bold" }, { type: "link", attrs: { href: "https://x.com" } }] },
            ],
          },
          { type: "heading", content: [{ type: "text", text: "Section" }] },
        ],
      },
      { type: "emailButton", attrs: { label: "Click me", href: "https://example.com/go" } },
      { type: "emailDivider", attrs: {} },
      { type: "emailFooter", attrs: { companyName: "Acme", address: "1 Main St" } },
    ],
  };
}

// --- block model ------------------------------------------------------------
check("seven block types", EMAIL_BLOCK_TYPES.length === 7);
check("labels for all types", EMAIL_BLOCK_TYPES.every((t) => blockLabel(t).length > 0));
check("createBlock defaults", createBlock("emailButton").attrs?.label === "Read more");
check("attr fallback", attr({ type: "emailHero", attrs: {} }, "title", "fb") === "fb");

const dirty = normalizeDoc({
  type: "doc",
  content: [
    { type: "emailHero", attrs: { title: "Hi" } },
    { type: "nope", attrs: {} },
    "junk",
    { type: "emailText" },
  ],
});
check("normalizeDoc drops unknown nodes", dirty.content.length === 2);
check("normalizeDoc coerces missing attrs", dirty.content[1].attrs !== undefined);
check("normalizeDoc empty input", normalizeDoc(null).content.length === 0);

// --- inline text -------------------------------------------------------------
const lines = textLines(sampleDoc().content[2]);
check("textLines paragraph+heading", lines.length === 2 && lines[1].kind === "heading");
check("textLines marks", lines[0].runs[1].bold === true && lines[0].runs[1].href === "https://x.com");
check("word count", docWordCount(sampleDoc()) === 7, `got ${docWordCount(sampleDoc())}`);

// --- unsubscribe enforcement --------------------------------------------------
check("no unsubscribe initially", !docHasUnsubscribe(sampleDoc()));
const ensured = ensureUnsubscribe(sampleDoc(), unsubscribeUrlFor(BASE, "tok123"));
check("ensureUnsubscribe appends footer", ensured.content.length === 7);
check("unsubscribe detected after ensure", docHasUnsubscribe(ensured));
check(
  "token in url",
  unsubscribeUrlFor(BASE, "tok123") === "https://news.example.com/api/newsletter/unsubscribe?token=tok123",
);
const withBtn = normalizeDoc({
  type: "doc",
  content: [{ type: "emailButton", attrs: { label: "x", href: "https://news.example.com/api/newsletter/unsubscribe?token=a" } }],
});
check("button unsubscribe detected", docHasUnsubscribe(withBtn));
check("ensureUnsubscribe idempotent", ensureUnsubscribe(withBtn, "u").content.length === 1);

// --- brand --------------------------------------------------------------------
const brand = brandFromKit({
  colors: { primary: "#000000", accent: "#ff0000", text: "#111111" },
  fonts: { heading: "Impact", body: "Verdana" },
  name: "Acme",
});
check("brandFromKit accent", brand.colors.accent === "#ff0000");
check("brandFromKit falls back", brand.colors.muted === DEFAULT_BRAND.colors.muted);
check("brandFromKit company", brand.companyName === "Acme");

// --- rendering ------------------------------------------------------------------
const html = await renderNewsletter(sampleDoc(), { brand, baseUrl: BASE, unsubscribeToken: "tok123" });
check("html shell", html.includes("<html") && html.includes("</html>"));
check("hero title rendered", html.includes("Hello world"));
check("button label rendered", html.includes("Click me"));
check("brand accent on button", html.includes("#ff0000"));
check("heading font applied", html.includes("Impact"));
check("bold run rendered", html.includes("font-weight:700") || html.includes("font-weight: 700"));
check("link run rendered", html.includes('href="https://x.com"'));
check("divider rendered", html.includes("<hr"));
check("unsubscribe injected at render", html.includes("token=tok123") && html.includes("Unsubscribe"));
check("footer company", html.includes("Acme"));

const htmlNoBrand = await renderNewsletter(sampleDoc(), { baseUrl: BASE });
check("default brand fallback", htmlNoBrand.includes(DEFAULT_BRAND.colors.accent));

// --- guardrails ------------------------------------------------------------------
const guardBase = {
  domainStatus: "verified",
  testSentAt: new Date(),
  subscriberCount: 10,
  doc: sampleDoc(),
  unsubscribeUrl: unsubscribeUrlFor(BASE, "t"),
};
check("guardrails pass", checkBroadcastGuardrails(guardBase).ok);
check(
  "unverified domain blocked",
  !checkBroadcastGuardrails({ ...guardBase, domainStatus: "pending" }).ok,
);
check(
  "no test send blocked",
  !checkBroadcastGuardrails({ ...guardBase, testSentAt: null }).ok,
);
check(
  "zero subscribers blocked",
  !checkBroadcastGuardrails({ ...guardBase, subscriberCount: 0 }).ok,
);

// --- CSV import --------------------------------------------------------------------
check("valid email", isValidEmail("a@b.co"));
check("invalid email rejected", !isValidEmail("not-an-email") && !isValidEmail("a@b"));
const mapping = mapSubscriberColumns(["Email Address", "Full Name", "Zip"]);
check("column mapping", mapping?.email === "Email Address" && mapping?.name === "Full Name");
check("no email column → null", mapSubscriberColumns(["zip", "city"]) === null);
const csv = parseSubscriberCsv([
  { row: 2, values: { email: "A@x.com ", name: "Ann" } },
  { row: 3, values: { email: "bad", name: "" } },
  { row: 4, values: { email: "", name: "" } },
  { row: 5, values: { email: "a@x.com", name: "dup" } },
]);
check("csv valid rows", csv.valid.length === 1 && csv.valid[0].email === "a@x.com" && csv.valid[0].name === "Ann");
check("csv errors", csv.errors.length === 3);
check("csv cap constant", SUBSCRIBER_CSV_CAP === 10_000);

// --- starter templates ---------------------------------------------------------------
check("three starters", STARTER_TEMPLATES.length === 3);
check(
  "starters normalize clean",
  STARTER_TEMPLATES.every((s) => normalizeDoc(s.doc).content.length === s.doc.content.length),
);
check(
  "starters render",
  (await Promise.all(STARTER_TEMPLATES.map((s) => renderNewsletter(s.doc, { baseUrl: BASE })))).every((h) =>
    h.includes("Unsubscribe"),
  ),
);

// --- mock Resend port -------------------------------------------------------------------
const mock = new MockResendPort();
const seg = await mock.createSegment("Marketr · List");
check("mock segment", seg.id.startsWith("mock_seg_"));
await mock.createContact(seg.id, { email: "a@x.com", firstName: "Ann" });
check("mock contact recorded", mock.contacts.length === 1);
const dom = await mock.createDomain("example.com");
check("mock domain records include spf+dkim+dmarc", 
  dom.records.some((r) => r.purpose === "spf") &&
    dom.records.some((r) => r.purpose === "dkim") &&
    dom.records.some((r) => r.purpose === "dmarc-note"),
);
check("dmarc record shape", dmarcRecordFor("example.com").name === "_dmarc.example.com");
const before = await mock.getDomain(dom.id);
check("mock domain pending", before.status === "pending");
await mock.verifyDomain(dom.id);
check("mock domain verified", (await mock.getDomain(dom.id)).status === "verified");
const batch = await mock.sendBatch([
  { from: "a@example.com", to: "b@x.com", subject: "Hi", html: "<p>hi</p>", headers: { "List-Unsubscribe": "<u>" } },
]);
check("mock batch ids", batch.ids.length === 1);
await mock.sendEmail({ from: "a@example.com", to: "me@x.com", subject: "[TEST] Hi", html: "<p>t</p>" });
check("mock test email recorded", mock.testEmails.length === 1);
check("no live calls", mock.calls.every((c) => typeof c.op === "string"));

// --- sendBroadcast guardrail path (mock db) ----------------------------------------------
function fakeDb(broadcast: Record<string, unknown>, subscribers: { email: string; token: string }[]) {
  return {
    newsletterBroadcast: {
      findFirst: async () => broadcast,
      update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(broadcast, data),
    },
    subscriber: {
      count: async () => subscribers.length,
      findMany: async () => subscribers,
    },
    brandKit: { findFirst: async () => null },
    newsletterSettings: { findUnique: async () => ({ defaultFromName: "Acme News" }) },
    fileChangeLog: { create: async () => {} },
  } as unknown as PrismaClient;
}

const blockedBroadcast = {
  id: "b1", subject: "News", listId: "l1",
  domain: { domain: "example.com", status: "pending" },
  templateSnapshot: sampleDoc(), brandKitId: null,
  status: "draft", testSentAt: null, list: { name: "L" },
};
const port2 = new MockResendPort();
let threw = "";
try {
  await sendBroadcast(fakeDb(blockedBroadcast, [{ email: "a@x.com", token: "t1" }]), "b1", "ws1", "p1", port2);
} catch (e) {
  threw = e instanceof Error ? e.message : "";
}
check("sendBroadcast blocked: unverified domain", /not verified/i.test(threw), threw);
check("sendBroadcast marked failed", blockedBroadcast.status === "failed");
check("no emails sent on guardrail failure", port2.batchSends.length === 0);

const okBroadcast = {
  id: "b2", subject: "News", listId: "l1",
  domain: { domain: "example.com", status: "verified" },
  templateSnapshot: sampleDoc(), brandKitId: null,
  status: "draft", testSentAt: new Date(), list: { name: "L" },
};
const port3 = new MockResendPort();
const subs = [
  { email: "a@x.com", token: "tokA" },
  { email: "b@x.com", token: "tokB" },
];
const { sent } = await sendBroadcast(fakeDb(okBroadcast, subs), "b2", "ws1", "p1", port3);
check("sendBroadcast sent count", sent === 2);
check("sendBroadcast marked sent", okBroadcast.status === "sent");
check("one batch call", port3.batchSends.length === 1 && port3.batchSends[0].length === 2);
const [mailA, mailB] = port3.batchSends[0];
check("per-recipient token A", mailA.html.includes("token=tokA") && !mailA.html.includes("token=tokB"));
check("per-recipient token B", mailB.html.includes("token=tokB") && !mailB.html.includes("token=tokA"));
check("one-click headers", mailA.headers?.["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click");
check("from header", mailA.from === "Acme News <newsletter@example.com>");

// --- webhook handler -------------------------------------------------------------------------
const whDb = {
  subscriber: {
    updateMany: async () => ({ count: 2 }),
  },
} as unknown as PrismaClient;
const wh = await handleResendWebhook(whDb, { type: "email.bounced", data: { to: ["a@x.com"] } });
check("webhook bounce handled", wh.handled && wh.updated === 2);
const wh2 = await handleResendWebhook(whDb, { type: "email.opened", data: {} });
check("webhook ignores other events", !wh2.handled);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
