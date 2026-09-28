// Marketr — Phase 13D Worker A: disclosure-required tests.
// Run: npx tsx --test lib/voice/__tests__/disclosure-required.test.ts
// Pure core (hasAiDisclosure) — no DB, no network.
// Contract: the opening must contain BOTH an AI-identity marker AND an
// outbound-calling context. Either alone fails.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { hasAiDisclosure, disclosureWarning } from "../scripts";

describe("hasAiDisclosure", () => {
  it("proper disclosure passes", () => {
    assert.equal(
      hasAiDisclosure("Hi, I'm an AI assistant calling on behalf of Acme Roofing."),
      true,
    );
  });

  it("artificial intelligence phrasing passes", () => {
    assert.equal(
      hasAiDisclosure(
        "Hello, this is an artificial intelligence assistant reaching out on behalf of Acme.",
      ),
      true,
    );
  });

  it("missing AI identity → refused", () => {
    assert.equal(
      hasAiDisclosure("Hi, I'm calling on behalf of Acme Roofing today."),
      false,
    );
  });

  it("missing outbound context → refused (inbound-safe is not outbound-safe)", () => {
    assert.equal(hasAiDisclosure("Hi, I'm an AI assistant. How can I help?"), false);
  });

  it("empty opening → refused", () => {
    assert.equal(hasAiDisclosure(""), false);
    assert.equal(hasAiDisclosure("   "), false);
  });

  it("human-sounding opening → refused", () => {
    assert.equal(
      hasAiDisclosure("Hey, this is Jake from Acme, do you have a minute?"),
      false,
    );
  });

  it("virtual assistant + on behalf of passes", () => {
    assert.equal(
      hasAiDisclosure(
        "Hi, this is a virtual assistant calling on behalf of Acme Roofing.",
      ),
      true,
    );
  });
});

describe("disclosureWarning", () => {
  it("warns when disclosure is missing", () => {
    const w = disclosureWarning({ opening: "Hi, I'm calling about your roof." });
    assert.ok(w);
    assert.ok(w.includes("disclosure"));
  });

  it("no warning when disclosure is present", () => {
    const w = disclosureWarning({
      opening: "Hi, I'm an AI assistant calling on behalf of Acme.",
    });
    assert.equal(w, null);
  });
});
