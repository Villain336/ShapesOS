// ShapesOS Phase 10 (ops-core): CRM normalization + dedupe identity. Unit.
// Run: npx tsx --test lib/ops/__tests__/p10-crm.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { companyDomainFromEmail, dealStatusForStage, normalizeCompanyName, normalizeDomain, normalizeEmail } from "../crm";
import { OPS_ENTITY_MAP } from "../entities";

describe("CRM dedupe identity", () => {
  it("normalizes emails and rejects junk", () => {
    assert.equal(normalizeEmail("  Ann@Acme.COM "), "ann@acme.com");
    assert.equal(normalizeEmail("not-an-email"), null);
    assert.equal(normalizeEmail(null), null);
  });

  it("normalizes domains from urls, hosts and emails", () => {
    assert.equal(normalizeDomain("https://www.Acme.com/about?x=1"), "acme.com");
    assert.equal(normalizeDomain("WWW.ACME.CO.UK"), "acme.co.uk");
    assert.equal(normalizeDomain("ann@sub.acme.io"), "sub.acme.io");
    assert.equal(normalizeDomain("acme"), null);
    assert.equal(normalizeDomain(""), null);
  });

  it("free-mail addresses never identify a company", () => {
    assert.equal(companyDomainFromEmail("bob@gmail.com"), null);
    assert.equal(companyDomainFromEmail("bob@ICLOUD.com"), null);
    assert.equal(companyDomainFromEmail("bob@acme.com"), "acme.com");
  });

  it("company names collapse whitespace", () => {
    assert.equal(normalizeCompanyName("  Acme   Corp "), "Acme Corp");
    assert.equal(normalizeCompanyName("   "), null);
  });

  it("deal status follows the canonical closed stages", () => {
    assert.equal(dealStatusForStage("won"), "won");
    assert.equal(dealStatusForStage("lost"), "lost");
    assert.equal(dealStatusForStage("proposal"), "open");
  });

  it("deal moves are free writes (never gated) and lead links are not patchable", () => {
    assert.deepEqual(OPS_ENTITY_MAP["deals"]!.gatedTransitions, []);
    assert.equal(OPS_ENTITY_MAP["deals"]!.patchSchema.safeParse({ leadId: "x" }).success, false);
    assert.equal(OPS_ENTITY_MAP["contacts"]!.patchSchema.safeParse({ leadId: "x" }).success, false);
  });
});
