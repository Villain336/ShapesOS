// Marketr — Legal/Compliance slice 5 tests: digital-properties module.
// Run: npx tsx --test lib/legal/__tests__/digital.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  HULLCHECK_LAYERS,
  SELF_ASSESSMENT_CHECKLIST,
  answersToFindings,
  assessmentChecklistForKind,
  findingSourceLabel,
  isValidFindingSource,
  isValidFindingStatusTransition,
  isValidHullcheckLayer,
  lowerSeverity,
  validateChecklistSeed,
  validateDigitalScan,
  validatePropertyUrl,
  type DigitalFindingInput,
  type DigitalScan,
} from "../digital";
import { OBLIGATION_TEMPLATES } from "../seeds";
import { LegalError } from "../types";

describe("HULLCHECK_LAYERS taxonomy", () => {
  it("covers the six legal/compliance/security layers (operate/certify are future)", () => {
    const values = HULLCHECK_LAYERS.map((l) => l.value);
    assert.deepEqual(values, [
      "detect",
      "fix",
      "prove",
      "harden",
      "document",
      "comply",
    ]);
  });

  it("every layer has a plain-English label and coverage line", () => {
    for (const layer of HULLCHECK_LAYERS) {
      assert.ok(layer.label.trim(), `layer ${layer.value}: label`);
      assert.ok(layer.whatItCovers.trim(), `layer ${layer.value}: coverage`);
    }
  });

  it("rejects the future layers in v1", () => {
    assert.equal(isValidHullcheckLayer("operate"), false);
    assert.equal(isValidHullcheckLayer("certify"), false);
    assert.equal(isValidHullcheckLayer("nope"), false);
  });
});

describe("validateChecklistSeed", () => {
  it("passes for the shipped checklist", () => {
    validateChecklistSeed();
  });

  it("every item has a unique key, valid layer/kind/severity, and plain-English copy", () => {
    const keys = SELF_ASSESSMENT_CHECKLIST.map((i) => i.key);
    assert.equal(new Set(keys).size, keys.length, "duplicate keys");
    for (const item of SELF_ASSESSMENT_CHECKLIST) {
      assert.equal(isValidHullcheckLayer(item.layer), true, item.key);
      assert.ok(item.kinds.length > 0, `${item.key}: kinds`);
      assert.ok(item.question.trim(), `${item.key}: question`);
      assert.ok(item.gapTitle.trim(), `${item.key}: gapTitle`);
      // Hullcheck's core insight: every finding must carry a
      // "what this means for your business" line.
      assert.ok(
        item.gapSummary.trim().length > 40,
        `${item.key}: plain-English summary`,
      );
    }
  });

  it("all six layers appear at least once in the checklist", () => {
    const used = new Set(SELF_ASSESSMENT_CHECKLIST.map((i) => i.layer));
    for (const layer of HULLCHECK_LAYERS) {
      assert.ok(used.has(layer.value), `layer ${layer.value} unused`);
    }
  });
});

describe("assessmentChecklistForKind", () => {
  it("drops app-only items for websites", () => {
    const website = assessmentChecklistForKind("website");
    const app = assessmentChecklistForKind("app");
    assert.ok(app.length > website.length, "apps get more questions");
    assert.ok(
      website.every((i) => i.kinds.includes("website")),
      "every website item applies to websites",
    );
    assert.equal(
      website.some((i) => i.key === "rls-misconfigured"),
      false,
      "database question is app-only",
    );
  });
});

describe("answersToFindings", () => {
  const answers = (overrides: Record<string, "yes" | "no" | "unsure"> = {}) => ({
    ...Object.fromEntries(
      assessmentChecklistForKind("website").map((i) => [i.key, "yes" as const]),
    ),
    ...overrides,
  });

  it("'no' generates a finding at full severity with the source labeled", () => {
    const findings = answersToFindings("website", answers({ "privacy-policy-missing": "no" }));
    assert.equal(findings.length, 1);
    const f = findings[0];
    assert.equal(f.itemKey, "privacy-policy-missing");
    assert.equal(f.hullcheckLayer, "comply");
    assert.equal(f.severity, "high");
    assert.equal(f.source, "self_assessment");
    assert.ok(f.title.length > 0 && f.plainEnglishSummary.length > 0);
  });

  it("'yes' generates nothing", () => {
    assert.deepEqual(answersToFindings("website", answers()), []);
  });

  it("'unsure' flags at one severity lower with an unverified marker", () => {
    const findings = answersToFindings("website", answers({ "secrets-in-bundle": "unsure" }));
    assert.equal(findings.length, 1);
    const f = findings[0];
    // secrets-in-bundle is high → unsure drops to medium.
    assert.equal(f.severity, "medium");
    assert.ok(f.title.startsWith("Unverified:"), `title: ${f.title}`);
    assert.ok(
      f.plainEnglishSummary.includes("not sure"),
      "summary must say why it is flagged",
    );
  });

  it("unanswered items are skipped (the tenant can walk the list later)", () => {
    const findings = answersToFindings("website", {
      "privacy-policy-missing": "no",
    });
    assert.equal(findings.length, 1);
  });

  it("rejects answers to unknown item keys", () => {
    assert.throws(
      () => answersToFindings("website", { "not-a-real-item": "no" }),
      (e: unknown) => e instanceof LegalError && e.code === "UNKNOWN_CHECKLIST_ITEM",
    );
  });

  it("rejects invalid answer values", () => {
    assert.throws(
      () =>
        answersToFindings("website", {
          "privacy-policy-missing": "maybe" as never,
        }),
      (e: unknown) => e instanceof LegalError && e.code === "INVALID_ANSWER",
    );
  });

  it("app-only answers are rejected for a website property", () => {
    assert.throws(
      () => answersToFindings("website", { "rls-misconfigured": "no" }),
      (e: unknown) => e instanceof LegalError && e.code === "UNKNOWN_CHECKLIST_ITEM",
    );
  });

  it("multiple gaps produce one finding each", () => {
    const findings = answersToFindings("app", {
      "privacy-policy-missing": "no",
      "secrets-in-bundle": "no",
      "rate-limiting": "unsure",
    });
    assert.equal(findings.length, 3);
  });
});

describe("obligation linking (slice 1)", () => {
  it("every checklist obligationKey exists in the obligation templates", () => {
    const keys = new Set(OBLIGATION_TEMPLATES.map((t) => t.key));
    for (const item of SELF_ASSESSMENT_CHECKLIST) {
      if (item.obligationKey) {
        assert.ok(
          keys.has(item.obligationKey),
          `${item.key}: unknown obligation ${item.obligationKey}`,
        );
      }
    }
  });

  it("the comply items link into the expected obligations", () => {
    const byKey = new Map(SELF_ASSESSMENT_CHECKLIST.map((i) => [i.key, i]));
    assert.equal(byKey.get("privacy-policy-missing")!.obligationKey, "saas-terms-and-privacy");
    assert.equal(byKey.get("terms-missing")!.obligationKey, "saas-terms-and-privacy");
    assert.equal(byKey.get("cookie-consent-missing")!.obligationKey, "data-privacy-review");
    assert.equal(byKey.get("data-export-deletion-missing")!.obligationKey, "data-privacy-review");
  });

  it("legal items carry the confirm-with-professional flag", () => {
    const byKey = new Map(SELF_ASSESSMENT_CHECKLIST.map((i) => [i.key, i]));
    for (const key of [
      "privacy-policy-missing",
      "terms-missing",
      "cookie-consent-missing",
      "accessibility-gaps",
      "data-export-deletion-missing",
    ]) {
      assert.equal(byKey.get(key)!.confirmWithProfessional, true, key);
    }
  });
});

describe("isValidFindingStatusTransition", () => {
  it("open moves to fixed or dismissed", () => {
    assert.equal(isValidFindingStatusTransition("open", "fixed"), true);
    assert.equal(isValidFindingStatusTransition("open", "dismissed"), true);
  });

  it("closed findings reopen (a 'fixed' gap can regress)", () => {
    assert.equal(isValidFindingStatusTransition("fixed", "open"), true);
    assert.equal(isValidFindingStatusTransition("dismissed", "open"), true);
  });

  it("closed findings cannot move sideways", () => {
    assert.equal(isValidFindingStatusTransition("fixed", "dismissed"), false);
    assert.equal(isValidFindingStatusTransition("dismissed", "fixed"), false);
  });

  it("same-status updates are idempotent", () => {
    assert.equal(isValidFindingStatusTransition("open", "open"), true);
    assert.equal(isValidFindingStatusTransition("fixed", "fixed"), true);
  });
});

describe("source labeling (guardrail: never invent scan results)", () => {
  it("every source has a visible UI label", () => {
    assert.equal(findingSourceLabel("self_assessment"), "Self-assessment");
    assert.equal(findingSourceLabel("manual_import"), "Added manually");
    assert.equal(findingSourceLabel("hullcheck_engine"), "Hullcheck scan");
  });

  it("unknown sources are rejected", () => {
    assert.equal(isValidFindingSource("automated_scan"), false);
    assert.equal(isValidFindingSource(""), false);
  });
});

describe("validateDigitalScan (future-engine ingestion shape)", () => {
  const validScan: DigitalScan = {
    source: "manual_import",
    scannedAt: "2026-10-01T12:00:00.000Z",
    propertyId: "prop_123",
    findings: [
      {
        itemKey: null,
        hullcheckLayer: "detect",
        title: "Secret in bundle",
        plainEnglishSummary: "An API key was found in public JavaScript.",
        severity: "high",
        obligationKey: null,
        source: "manual_import",
      },
    ],
  };

  it("accepts a well-formed manual import scan", () => {
    validateDigitalScan(validScan);
  });

  it("accepts a well-formed self-assessment scan", () => {
    validateDigitalScan({ ...validScan, source: "self_assessment" });
  });

  it("accepts hullcheck_engine only with an engine version (provenance)", () => {
    validateDigitalScan({
      ...validScan,
      source: "hullcheck_engine",
      engineVersion: "hc-0.1.0",
    });
    assert.throws(
      () => validateDigitalScan({ ...validScan, source: "hullcheck_engine" }),
      (e: unknown) => e instanceof LegalError && e.code === "INVALID_SCAN",
    );
  });

  it("rejects unknown sources, layers, and severities", () => {
    assert.throws(
      () => validateDigitalScan({ ...validScan, source: "mystery" }),
      (e: unknown) => e instanceof LegalError,
    );
    const badLayer: DigitalFindingInput[] = [
      { ...validScan.findings[0], hullcheckLayer: "scan" as never },
    ];
    assert.throws(
      () => validateDigitalScan({ ...validScan, findings: badLayer }),
      (e: unknown) => e instanceof LegalError,
    );
    const badSev: DigitalFindingInput[] = [
      { ...validScan.findings[0], severity: "urgent" as never },
    ];
    assert.throws(
      () => validateDigitalScan({ ...validScan, findings: badSev }),
      (e: unknown) => e instanceof LegalError,
    );
  });

  it("rejects findings without plain-English copy", () => {
    const noSummary: DigitalFindingInput[] = [
      { ...validScan.findings[0], plainEnglishSummary: "  " },
    ];
    assert.throws(
      () => validateDigitalScan({ ...validScan, findings: noSummary }),
      (e: unknown) => e instanceof LegalError,
    );
  });

  it("rejects non-objects and missing fields", () => {
    assert.throws(() => validateDigitalScan(null), (e: unknown) => e instanceof LegalError);
    assert.throws(
      () => validateDigitalScan({ ...validScan, propertyId: "" }),
      (e: unknown) => e instanceof LegalError,
    );
    assert.throws(
      () => validateDigitalScan({ ...validScan, scannedAt: "not-a-date" }),
      (e: unknown) => e instanceof LegalError,
    );
  });
});

describe("lowerSeverity", () => {
  it("drops one notch, floored at low", () => {
    assert.equal(lowerSeverity("critical"), "high");
    assert.equal(lowerSeverity("high"), "medium");
    assert.equal(lowerSeverity("medium"), "low");
    assert.equal(lowerSeverity("low"), "low");
  });
});

describe("validatePropertyUrl", () => {
  it("accepts http/https URLs and normalizes them", () => {
    assert.equal(
      validatePropertyUrl("https://example.com"),
      "https://example.com/",
    );
  });

  it("treats empty as no URL", () => {
    assert.equal(validatePropertyUrl(""), null);
    assert.equal(validatePropertyUrl(null), null);
    assert.equal(validatePropertyUrl(undefined), null);
  });

  it("rejects non-web schemes and garbage", () => {
    assert.throws(
      () => validatePropertyUrl("ftp://example.com"),
      (e: unknown) => e instanceof LegalError && e.code === "INVALID_URL",
    );
    assert.throws(
      () => validatePropertyUrl("not a url"),
      (e: unknown) => e instanceof LegalError && e.code === "INVALID_URL",
    );
  });
});
