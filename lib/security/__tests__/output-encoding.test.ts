// Phase 1 (untrusted content): CSV formula injection, javascript: links in
// programmatic SEO HTML, Telegram token validation.
// Run: npx tsx --test lib/security/__tests__/output-encoding.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { csvCell, csvRow } from "../../csv";
import { safeLinkHref, tiptapToHtml } from "../../seo/programmatic";
import { exportSheetCsv } from "../../univer/export";
import { validateChannelConfig } from "../../alerts/channels";
import { sendTelegram } from "../../alerts/adapters";
import { leadsToCsv } from "../../../app/api/crm/leads/export/route";

describe("csvCell — formula injection", () => {
  it("neutralizes cells that start with = + - @ TAB CR", () => {
    assert.equal(csvCell("=HYPERLINK(\"http://evil\",\"x\")"), `"'=HYPERLINK(""http://evil"",""x"")"`);
    assert.equal(csvCell("+1+cmd|' /C calc'!A0"), "'+1+cmd|' /C calc'!A0");
    assert.equal(csvCell("-2+3"), "'-2+3");
    assert.equal(csvCell("@SUM(A1:A9)"), "'@SUM(A1:A9)");
    assert.equal(csvCell("\t=1"), "'\t=1");
    assert.equal(csvCell("\r=1"), `"'\r=1"`);
  });

  it("leaves numbers, plain text and empty values alone; quotes per RFC 4180", () => {
    assert.equal(csvCell(-5), "-5");
    assert.equal(csvCell(3.25), "3.25");
    assert.equal(csvCell("Acme, Inc."), `"Acme, Inc."`);
    assert.equal(csvCell('say "hi"'), `"say ""hi"""`);
    assert.equal(csvCell(null), "");
    assert.equal(csvCell(undefined, { alwaysQuote: true }), `""`);
    assert.equal(csvCell("x", { alwaysQuote: true }), `"x"`);
    assert.equal(csvRow(["a", 1, "=b"]), "a,1,'=b");
  });

  it("CRM lead export (public-form data) is neutralized", () => {
    const csv = leadsToCsv([
      {
        name: "=cmd|'/c calc'!A1",
        email: "x@y.example",
        phone: null,
        company: "@evil",
        title: null,
        source: "form",
        sourceDetail: null,
        stage: "new",
        score: 1,
        valueCents: null,
        ownerName: null,
        createdAt: new Date(0),
        pipeline: { name: "Default" },
      },
    ]);
    const row = csv.split("\n")[1];
    assert.ok(row.startsWith("'=cmd"), row);
    assert.ok(row.includes(",'@evil,"), row);
  });

  it("Univer sheet export neutralizes text but keeps numeric cells", () => {
    const csv = exportSheetCsv({
      sheets: { s1: { name: "S", cellData: { 0: { 0: { v: "=1+1" }, 1: { v: -7 }, 2: { v: "ok" } } } } },
    } as never);
    assert.equal(csv, "'=1+1,-7,ok\r\n");
  });
});

describe("programmatic SEO links", () => {
  it("rejects javascript:/data:/vbscript: and obfuscated variants", () => {
    for (const bad of [
      "javascript:alert(1)",
      " JavaScript:alert(1)",
      "java\nscript:alert(1)",
      "\u0001javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
    ]) {
      assert.equal(safeLinkHref(bad), "#", JSON.stringify(bad));
    }
  });

  it("keeps http(s), mailto, tel and relative links", () => {
    for (const ok of ["https://example.com/a", "http://x.example", "mailto:a@b.example", "tel:+15551234", "/pricing", "#faq", "pricing", "?q=1"]) {
      assert.equal(safeLinkHref(ok), ok);
    }
  });

  it("tiptapToHtml never emits a javascript: href", () => {
    const html = tiptapToHtml({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "click", marks: [{ type: "link", attrs: { href: "javascript:alert(document.cookie)" } }] }],
        },
      ],
    });
    assert.doesNotMatch(html, /javascript:/i);
    assert.match(html, /<a href="#">click<\/a>/);
  });
});

describe("Telegram channel validation", () => {
  const good = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
  it("accepts a BotFather token and numeric / @channel chat ids", () => {
    assert.equal(validateChannelConfig("telegram", { botToken: good, chatId: "-1001234567890" }).ok, true);
    assert.equal(validateChannelConfig("telegram", { botToken: good, chatId: "@shapes_alerts" }).ok, true);
  });
  it("rejects tokens that would rewrite the Bot API request path", () => {
    for (const botToken of ["x/../../getUpdates?", "123:short", `${good}/../x`, `${good}#`, "abc:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"]) {
      assert.equal(validateChannelConfig("telegram", { botToken, chatId: "1" }).ok, false, botToken);
    }
    assert.equal(validateChannelConfig("telegram", { botToken: good, chatId: "1/../2" }).ok, false);
  });
  it("sendTelegram refuses a malformed stored token without calling fetch", async () => {
    const realFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;
    try {
      const r = await sendTelegram({ botToken: "x/../y", chatId: "1" }, { title: "t", body: "b" } as never);
      assert.equal(r.ok, false);
      assert.equal(called, false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
