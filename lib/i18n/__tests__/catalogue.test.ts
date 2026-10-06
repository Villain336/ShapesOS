// ShapesOS — Phase 18.1 (WS=find): i18n catalogues, ICU subset, formatting (unit).
// Run: npx tsx --test lib/i18n/__tests__/catalogue.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { en } from "../messages/en";
import { es } from "../messages/es";
import { createTranslator, lookup, mergeCatalogues, type MessageKey } from "../index";
import { formatIcu, icuArgumentNames, IcuSyntaxError, parseIcu } from "../icu";
import { negotiateLocale } from "../locales";
import { formatDate, formatMoney, formatNumber, formatRelative } from "../format";
import { NAV_GROUPS, allNavItems } from "@/lib/nav/config";
import { SETTINGS_GROUPS } from "@/components/settings/settingsSections";
import { INBOX_SOURCES } from "@/lib/approvals/types";
import { RECORD_KINDS } from "@/lib/search/kinds";

function leaves(obj: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(key, v);
    else for (const [kk, vv] of leaves(v, key)) out.set(kk, vv);
  }
  return out;
}

const EN = leaves(en);
const ES = leaves(es);

describe("catalogue parity", () => {
  it("en and es have exactly the same keys", () => {
    const missing = [...EN.keys()].filter((k) => !ES.has(k));
    const extra = [...ES.keys()].filter((k) => !EN.has(k));
    assert.deepEqual(missing, [], "keys missing in es");
    assert.deepEqual(extra, [], "keys only in es");
    assert.ok(EN.size > 300, `a real shell catalogue (${EN.size} keys)`);
  });

  it("every message parses and both languages use the same ICU arguments", () => {
    for (const [key, src] of EN) {
      const other = ES.get(key)!;
      assert.doesNotThrow(() => parseIcu(src), `en ${key}`);
      assert.doesNotThrow(() => parseIcu(other), `es ${key}`);
      assert.deepEqual(icuArgumentNames(other), icuArgumentNames(src), `arguments of ${key}`);
    }
  });

  it("no message is empty and es is actually translated where it should be", () => {
    for (const [key, v] of ES) assert.ok(v.trim().length > 0, `es ${key} is empty`);
    const same = [...EN].filter(([k, v]) => ES.get(k) === v && /[a-z]{4,}/.test(v) && !/ShapesOS|CRM|CAD|MCP|API|SEO|Webhooks|Playbooks?|Flywheel|Clips|Apps|Social|Legal|General|Lead|Ticket|Chats|English|Español|Gmail|Outlook|Google/.test(v));
    assert.ok(same.length < 8, `untranslated es strings: ${same.map(([k]) => k).join(", ")}`);
  });

  it("covers every nav destination, settings page, inbox source and record kind", () => {
    const navItems = en.nav.items as Record<string, unknown>;
    for (const item of allNavItems(NAV_GROUPS)) assert.ok(navItems[item.href], `nav ${item.href}`);
    for (const g of NAV_GROUPS) if (g.title) assert.ok((en.nav.groups as Record<string, string>)[g.id], `nav group ${g.id}`);
    const pages = en.settings.pages as Record<string, unknown>;
    for (const g of SETTINGS_GROUPS) {
      assert.ok((en.settings.groups as Record<string, string>)[g.id], `settings group ${g.id}`);
      for (const p of g.pages) assert.ok(pages[p.href], `settings page ${p.href}`);
    }
    for (const s of INBOX_SOURCES) assert.ok((en.approvals.sources as Record<string, string>)[s], `inbox source ${s}`);
    for (const k of RECORD_KINDS) assert.ok((en.records.kinds as Record<string, string>)[k], `record kind ${k}`);
  });
});

describe("ICU subset", () => {
  it("interpolates and pluralizes with CLDR rules", () => {
    assert.equal(formatIcu("Hi {name}", { name: "Ana" }), "Hi Ana");
    const msg = "{count, plural, =0 {none} one {# item} other {# items}}";
    assert.equal(formatIcu(msg, { count: 0 }, "en"), "none");
    assert.equal(formatIcu(msg, { count: 1 }, "en"), "1 item");
    assert.equal(formatIcu(msg, { count: 1234 }, "en"), "1,234 items");
    assert.equal(formatIcu(msg, { count: 1234 }, "es"), "1234 items", "es groups from 5 digits");
    assert.equal(formatIcu(msg, { count: 12345 }, "es"), "12.345 items");
  });

  it("select, nesting and missing values", () => {
    const msg = "{kind, select, file {A file {name}} other {Something}}";
    assert.equal(formatIcu(msg, { kind: "file", name: "q3.pdf" }), "A file q3.pdf");
    assert.equal(formatIcu(msg, { kind: "doc" }), "Something");
    assert.equal(formatIcu("Hi {name}!", {}), "Hi !");
  });

  it("rejects malformed messages", () => {
    assert.throws(() => parseIcu("{count, plural, one {x}}"), IcuSyntaxError, "needs other");
    assert.throws(() => parseIcu("broken } brace"), IcuSyntaxError);
    assert.throws(() => parseIcu("{x, number}"), IcuSyntaxError);
  });

  it("values are text, never markup", () => {
    assert.equal(formatIcu("{v}", { v: "<script>" }), "<script>", "React escapes it at render");
  });
});

describe("translator", () => {
  it("translates typed keys in each locale", () => {
    const tEn = createTranslator("en", en);
    const tEs = createTranslator("es", mergeCatalogues(en, es));
    assert.equal(tEn("shell.newTask"), "New task");
    assert.equal(tEs("shell.newTask"), "Nueva tarea");
    assert.equal(tEs("commandBar.results", { count: 1 }), "1 resultado");
    assert.equal(tEs("commandBar.results", { count: 3 }), "3 resultados");
    assert.equal(tEs("nav.items./dashboard/files.label" as MessageKey), "Archivos");
  });

  it("falls back to English, then to the key", () => {
    const partial = mergeCatalogues(en, { shell: { newTask: "Nueva tarea" } });
    const t = createTranslator("es", partial);
    assert.equal(t("shell.newTask"), "Nueva tarea");
    assert.equal(t("shell.signOut"), "Sign out", "untranslated → English");
    assert.equal(t("no.such.key" as MessageKey), "no.such.key");
    assert.equal(lookup(en, "shell"), undefined, "a branch is not a message");
  });
});

describe("locale negotiation", () => {
  it("picks the best supported language from Accept-Language", () => {
    assert.equal(negotiateLocale("es-MX,es;q=0.9,en;q=0.8"), "es");
    assert.equal(negotiateLocale("fr-FR,fr;q=0.9,es;q=0.5,en;q=0.4"), "es");
    assert.equal(negotiateLocale("en-GB,es;q=0.9"), "en");
    assert.equal(negotiateLocale("de,fr"), "en");
    assert.equal(negotiateLocale("es;q=0,en;q=0.1"), "en", "q=0 means not acceptable");
    assert.equal(negotiateLocale(null), "en");
    assert.equal(negotiateLocale("garbage;;;,"), "en");
  });
});

describe("dates and numbers in the person's zone", () => {
  const at = new Date("2026-06-15T18:30:00Z");
  it("formats in the time zone and language", () => {
    assert.equal(formatDate(at, { locale: "en", timeZone: "America/New_York" }, "time"), "2:30 PM");
    assert.equal(formatDate(at, { locale: "es", timeZone: "Europe/Madrid" }, "time"), "20:30");
    assert.equal(formatDate(at, { locale: "en", timeZone: "UTC", hourCycle: "h23" }, "time"), "18:30");
    assert.equal(formatDate(at, { locale: "es", timeZone: "Asia/Tokyo" }, "date"), "16 jun 2026", "next day in Tokyo");
    assert.equal(formatDate("not a date", { locale: "en" }), "");
  });
  it("numbers, money, relative time", () => {
    assert.equal(formatNumber(1234.5, { locale: "en" }), "1,234.5");
    assert.equal(formatMoney(123456, { locale: "en" }), "$1,234.56");
    assert.match(formatMoney(123456, { locale: "es" }), /1234,56\s?US\$/);
    assert.equal(formatRelative(new Date(at.getTime() - 3 * 60_000), { locale: "en" }, at), "3 minutes ago");
    assert.equal(formatRelative(new Date(at.getTime() - 3 * 60_000), { locale: "es" }, at), "hace 3 minutos");
    assert.equal(formatRelative(new Date(at.getTime() + 2 * 86_400_000), { locale: "es" }, at), "pasado mañana");
  });
});
