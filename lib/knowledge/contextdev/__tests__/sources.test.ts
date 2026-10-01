// Marketr — Wave 2 context.dev slice 2 tests: source governance (pure).
// Run: npx tsx --test lib/knowledge/contextdev/__tests__/sources.test.ts
//
// Pure: no database, no network. Covers domain extraction and the
// add_source governance decision (own domains auto-activate, third-party
// domains need one-time approval).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractDomain,
  classifySourceDomain,
  KnowledgeSourceError,
} from "../sources";

describe("extractDomain", () => {
  it("lowercases the hostname", () => {
    assert.equal(extractDomain("https://Example.COM/docs"), "example.com");
  });

  it("rejects invalid URLs", () => {
    assert.throws(() => extractDomain("not a url"), (e: unknown) => {
      assert.ok(e instanceof KnowledgeSourceError && e.code === "BAD_URL");
      return true;
    });
    assert.throws(() => extractDomain("https://localhost/x"), (e: unknown) => {
      assert.ok(e instanceof KnowledgeSourceError && e.code === "BAD_URL");
      return true;
    });
  });
});

describe("classifySourceDomain", () => {
  it("auto-activates the tenant's own domains", () => {
    assert.equal(classifySourceDomain("acme.com", ["acme.com"], []), "active");
    assert.equal(classifySourceDomain("ACME.com", ["acme.com"], []), "active");
  });

  it("auto-activates third-party domains approved once before", () => {
    assert.equal(classifySourceDomain("competitor.com", ["acme.com"], ["competitor.com"]), "active");
  });

  it("holds new third-party domains for approval", () => {
    assert.equal(classifySourceDomain("competitor.com", ["acme.com"], []), "pending_approval");
    assert.equal(classifySourceDomain("competitor.com", [], []), "pending_approval");
  });
});
