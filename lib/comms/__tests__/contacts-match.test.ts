// ShapesOS — Phase 18.2 (WS=comms): Contacts identity matching + suggestion
// scoring (unit, PURE).
// Run: npx tsx --test lib/comms/__tests__/contacts-match.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  candidatePairs,
  compareRecords,
  emailsIn,
  identitySummary,
  normalizeCompany,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  orderPair,
  SUGGEST_THRESHOLD,
  type PersonRecord,
} from "../contacts/match";

const rec = (over: Partial<PersonRecord> & Pick<PersonRecord, "kind" | "id">): PersonRecord => ({
  name: "",
  emails: [],
  phones: [],
  company: null,
  title: null,
  updatedAt: null,
  ...over,
});

describe("normalization", () => {
  it("emails: case, mailto, display names; garbage is null", () => {
    assert.equal(normalizeEmail(" Ada@Example.COM "), "ada@example.com");
    assert.equal(normalizeEmail("Ada Lovelace <ada@example.com>"), "ada@example.com");
    assert.equal(normalizeEmail("mailto:ada@example.com"), "ada@example.com");
    assert.equal(normalizeEmail("not an email"), null);
    assert.deepEqual(emailsIn(["@ada", "ada@x.io", "ADA@x.io", null]), ["ada@x.io"]);
  });
  it("phones: digits, the last 10, too short is null", () => {
    assert.equal(normalizePhone("+1 (415) 555-0100"), "4155550100");
    assert.equal(normalizePhone("415.555.0100"), "4155550100");
    assert.equal(normalizePhone("555-01"), null);
  });
  it("names and companies fold accents, titles, punctuation and legal suffixes", () => {
    assert.equal(normalizeName("Dr. Ana  María O'Neil-Ruiz"), "ana maria oneil ruiz");
    assert.equal(normalizeCompany("ACME, Inc."), "acme");
    assert.equal(normalizeCompany("Acme Corporation"), "acme");
  });
});

describe("compareRecords (evidence and score)", () => {
  const lead = rec({ kind: "lead", id: "l1", name: "Ana Ruiz", emails: ["ana@acme.com"], phones: ["+1 415 555 0100"], company: "Acme Inc" });
  it("same email is strong evidence", () => {
    const e = compareRecords(lead, rec({ kind: "ops_contact", id: "c1", name: "A. Ruiz", emails: ["ANA@acme.com"] }));
    assert.deepEqual(e.reasons, ["email"]);
    assert.equal(e.score, 0.95);
  });
  it("same phone", () => {
    assert.deepEqual(compareRecords(lead, rec({ kind: "connector_person", id: "p1", name: "Ana", phones: ["415-555-0100"] })).reasons, ["phone"]);
  });
  it("several kinds of evidence add up, capped below 1", () => {
    const e = compareRecords(lead, rec({ kind: "ops_contact", id: "c2", name: "Ana Ruiz", emails: ["ana@acme.com"], phones: ["4155550100"], company: "ACME" }));
    assert.deepEqual(e.reasons, ["email", "phone", "name_company"]);
    assert.equal(e.score, 0.99);
  });
  it("same name + company, or + the same company email domain; a free-mail domain is not evidence", () => {
    assert.deepEqual(compareRecords(lead, rec({ kind: "funding_contact", id: "f1", name: "ana ruiz", company: "Acme, Inc." })).reasons, ["name_company"]);
    assert.deepEqual(compareRecords(lead, rec({ kind: "funding_contact", id: "f2", name: "Ana Ruiz", emails: ["a.ruiz@acme.com"] })).reasons, ["name_domain"]);
    const gmail = compareRecords(rec({ kind: "lead", id: "x", name: "Ana Ruiz", emails: ["ana1@gmail.com"] }), rec({ kind: "lead", id: "y", name: "Ana Ruiz", emails: ["ana2@gmail.com"] }));
    assert.deepEqual(gmail.reasons, ["name"], "two gmail addresses prove nothing");
    assert.ok(gmail.score < SUGGEST_THRESHOLD, "a full name alone is below the bar");
  });
  it("a single-word name alone is no evidence at all; different people score 0", () => {
    assert.equal(compareRecords(rec({ kind: "lead", id: "a", name: "Ana" }), rec({ kind: "lead", id: "b", name: "Ana" })).score, 0);
    assert.equal(compareRecords(lead, rec({ kind: "lead", id: "z", name: "Bo Chen", emails: ["bo@acme.com"] })).score, 0);
  });
});

describe("candidatePairs (blocking, identities, remembered rejections)", () => {
  const a = rec({ kind: "lead", id: "a", name: "Ana Ruiz", emails: ["ana@acme.com"] });
  const b = rec({ kind: "ops_contact", id: "b", name: "Ana R.", emails: ["ana@acme.com"] });
  const c = rec({ kind: "connector_person", id: "c", name: "Ana Ruiz", phones: ["555 0100 999"], company: null });
  const d = rec({ kind: "funding_contact", id: "d", name: "Bo Chen", emails: ["bo@chen.vc"] });
  const own = (r: PersonRecord) => `i:${r.kind}:${r.id}`;
  it("suggests only pairs above the bar, canonical order, strongest first", () => {
    const pairs = candidatePairs([a, b, c, d], own);
    assert.equal(pairs.length, 1);
    assert.deepEqual([pairs[0]!.a.id, pairs[0]!.b.id], ["a", "b"], "lead:a sorts before ops_contact:b");
    assert.deepEqual(orderPair(b, a).map((r) => r.id), ["a", "b"], "lead:a < ops_contact:b");
  });
  it("never suggests records already in one identity", () => {
    assert.equal(candidatePairs([a, b], () => "same").length, 0);
  });
  it("a rejected identity pair is never suggested again", () => {
    assert.equal(candidatePairs([a, b], own, new Set([`${own(a)}|${own(b)}`, `${own(b)}|${own(a)}`])).length, 0);
  });
  it("one suggestion per identity pair (the strongest evidence wins)", () => {
    const b2 = rec({ kind: "ops_contact", id: "b2", name: "Ana Ruiz", emails: ["ana@acme.com"], phones: ["4155550100"] });
    const a2 = { ...a, phones: ["4155550100"] };
    const pairs = candidatePairs([a2, b2], own);
    assert.equal(pairs.length, 1);
    assert.deepEqual(pairs[0]!.evidence.reasons, ["email", "phone", "name_domain"]);
    assert.equal(pairs[0]!.evidence.score, 0.99);
  });
  it("a shared address on many records (info@) is not evidence", () => {
    const many = Array.from({ length: 60 }, (_, i) => rec({ kind: "lead", id: `m${i}`, name: `Person ${i}`, emails: ["info@shared.com"] }));
    assert.equal(candidatePairs(many, own).length, 0);
  });
});

describe("identitySummary", () => {
  it("prefers the Ops contact's name; unions emails, phones, companies", () => {
    const s = identitySummary([
      rec({ kind: "lead", id: "1", name: "ana ruiz", emails: ["ana@acme.com"], company: "Acme" }),
      rec({ kind: "ops_contact", id: "2", name: "Ana Ruiz", emails: ["ANA@acme.com", "ana.r@acme.com"], phones: ["+1 415 555 0100"], company: "Acme" }),
    ]);
    assert.equal(s.displayName, "Ana Ruiz");
    assert.deepEqual(s.emails, ["ana@acme.com", "ana.r@acme.com"]);
    assert.deepEqual(s.phones, ["+1 415 555 0100"]);
    assert.deepEqual(s.companies, ["Acme"]);
  });
});
