// Marketr — Phase 18 slice 4 tests: Walmart Connect guided flow + spend import.
// Run: npx tsx --test lib/adplatforms/walmart/__tests__/guided.test.ts
//
// Pure: registry flags, checklist data integrity, the CSV parser, the import
// input builder, and the fail-closed negatives (launch never executes for a
// guided platform). No DB, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ADS_PLATFORMS } from "../../types";
import { runAdsAction, AdsActionError } from "../../actions";
import type { SpendApprovalStore, SpendProposalStore } from "../../gate";
import {
  WalmartGuidedError,
  WALMART_GUIDED_STEPS,
  WALMART_PLACEMENT_OPTIONS,
  WALMART_CREATIVE_SPECS,
  WALMART_CSV_COLUMNS,
  WALMART_CSV_TEMPLATE,
  parseWalmartSpendCsv,
  buildWalmartImportInput,
} from "../guided";

const stubProposals = {
  create: () => Promise.reject(new Error("must not be called")),
  get: () => Promise.resolve(null),
} as unknown as SpendProposalStore;
const stubApprovals = {
  create: () => Promise.reject(new Error("must not be called")),
  getByProposalId: () => Promise.resolve(null),
} as unknown as SpendApprovalStore;

describe("walmart registry: guided-only (outcome B)", () => {
  it("registers walmart as guided with no API claims", () => {
    const def = ADS_PLATFORMS.walmart;
    assert.equal(def.authKind, "guided");
    assert.equal(def.guidedOnly, true);
    assert.equal(def.supportsApiLaunch, false);
    assert.equal(def.supportsReportingApi, false);
    assert.equal(def.oauthConnectorKey, undefined);
  });
});

describe("walmart guided checklist integrity", () => {
  it("has unique step ids and complete copy", () => {
    const ids = WALMART_GUIDED_STEPS.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const s of WALMART_GUIDED_STEPS) {
      assert.ok(s.title.length > 0, `step ${s.id} needs a title`);
      assert.ok(s.detail.length > 20, `step ${s.id} needs a real description`);
    }
  });

  it("names the Technology provider partner type (the Marketr-shaped path)", () => {
    const apply = WALMART_GUIDED_STEPS.find((s) => s.id === "partner-application");
    assert.ok(apply, "partner-application step must exist");
    assert.match(apply!.detail, /Technology provider/);
  });

  it("keeps private-key material out of commands (vault-bound)", () => {
    const keygen = WALMART_GUIDED_STEPS.find((s) => s.id === "rsa-keypair");
    assert.ok(keygen?.commands?.some((c) => c.includes("openssl")));
    for (const s of WALMART_GUIDED_STEPS) {
      assert.doesNotMatch(s.detail, /BEGIN (RSA )?PRIVATE KEY/);
    }
  });

  it("surfaces Vibe CTV as a placement option with a $0 minimum", () => {
    const vibe = WALMART_PLACEMENT_OPTIONS.find((p) => p.id === "vibe-ctv");
    assert.ok(vibe, "Vibe CTV placement option must exist (spec §2c)");
    assert.equal(vibe!.minimum, "$0");
    assert.ok(vibe!.name.length > 0);
  });

  it("documents Sponsored Brands creative specs (from the official API docs)", () => {
    assert.ok(WALMART_CREATIVE_SPECS.length > 0);
    const brands = WALMART_CREATIVE_SPECS[0]!;
    assert.match(brands.specs.join(" "), /1200/);
    assert.match(brands.specs.join(" "), /walmart\.com/);
  });
});

describe("walmart spend CSV parser", () => {
  const VALID = [
    "campaign_external_id,date,spend_cents,impressions,clicks,conversions,revenue_cents",
    "600001,2026-09-28,12500,8421,312,9,74900",
    "600002,2026-09-28,0,0,0,0,0",
  ].join("\n");

  it("parses a valid CSV and computes CTR", () => {
    const rows = parseWalmartSpendCsv(VALID);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.externalCampaignId, "600001");
    assert.equal(rows[0]!.spendCents, 12500);
    assert.equal(rows[0]!.impressions, 8421);
    assert.equal(rows[0]!.clicks, 312);
    assert.equal(rows[0]!.conversions, 9);
    assert.equal(rows[0]!.revenueCents, 74900);
    assert.ok(Math.abs(rows[0]!.ctr! - 312 / 8421) < 1e-9);
    assert.equal(rows[0]!.date.toISOString().slice(0, 10), "2026-09-28");
    // Zero-impression row: CTR is null, not NaN.
    assert.equal(rows[1]!.ctr, null);
  });

  it("tolerates a BOM, blank lines, and surrounding whitespace", () => {
    const rows = parseWalmartSpendCsv(`\uFEFF${VALID}\n\n   \n`);
    assert.equal(rows.length, 2);
  });

  it("parses quoted fields containing commas", () => {
    const rows = parseWalmartSpendCsv(
      `${WALMART_CSV_COLUMNS.join(",")}\n"60,0001",2026-09-28,100,10,1,0,500\n`,
    );
    assert.equal(rows[0]!.externalCampaignId, "60,0001");
  });

  it("rejects a missing required column", () => {
    assert.throws(
      () => parseWalmartSpendCsv("campaign_external_id,date\n600001,2026-09-28\n"),
      (e: unknown) => e instanceof WalmartGuidedError && e.code === "CSV_BAD_HEADER",
    );
  });

  it("rejects a ragged row with the line number", () => {
    assert.throws(
      () => parseWalmartSpendCsv(`${WALMART_CSV_COLUMNS.join(",")}\n600001,2026-09-28,100\n`),
      (e: unknown) =>
        e instanceof WalmartGuidedError && e.code === "CSV_BAD_ROW" && /Line 2/.test(e.message),
    );
  });

  it("rejects malformed and impossible dates with the line number", () => {
    assert.throws(
      () => parseWalmartSpendCsv(`${WALMART_CSV_COLUMNS.join(",")}\n600001,09/28/2026,100,10,1,0,500\n`),
      (e: unknown) => e instanceof WalmartGuidedError && e.code === "CSV_INVALID_DATE",
    );
    assert.throws(
      () => parseWalmartSpendCsv(`${WALMART_CSV_COLUMNS.join(",")}\n600001,2026-02-30,100,10,1,0,500\n`),
      (e: unknown) =>
        e instanceof WalmartGuidedError && e.code === "CSV_INVALID_DATE" && /not a real/.test(e.message),
    );
  });

  it("rejects negative and decimal money/counters", () => {
    const base = (spend: string) =>
      `${WALMART_CSV_COLUMNS.join(",")}\n600001,2026-09-28,${spend},10,1,0,500\n`;
    assert.throws(() => parseWalmartSpendCsv(base("-5")), (e: unknown) => e instanceof WalmartGuidedError && e.code === "CSV_INVALID_NUMBER");
    assert.throws(() => parseWalmartSpendCsv(base("12.5")), (e: unknown) => e instanceof WalmartGuidedError && e.code === "CSV_INVALID_NUMBER");
    assert.throws(() => parseWalmartSpendCsv(base("abc")), (e: unknown) => e instanceof WalmartGuidedError && e.code === "CSV_INVALID_NUMBER");
  });

  it("rejects empty input and header-only input", () => {
    assert.throws(() => parseWalmartSpendCsv("   \n"), (e: unknown) => e instanceof WalmartGuidedError && e.code === "CSV_EMPTY");
    assert.throws(
      () => parseWalmartSpendCsv(`${WALMART_CSV_COLUMNS.join(",")}\n`),
      (e: unknown) => e instanceof WalmartGuidedError && e.code === "CSV_EMPTY",
    );
  });

  it("rejects a blank campaign id", () => {
    assert.throws(
      () => parseWalmartSpendCsv(`${WALMART_CSV_COLUMNS.join(",")}\n ,2026-09-28,100,10,1,0,500\n`),
      (e: unknown) => e instanceof WalmartGuidedError && e.code === "CSV_BAD_ROW",
    );
  });

  it("the shipped template parses cleanly", () => {
    const rows = parseWalmartSpendCsv(WALMART_CSV_TEMPLATE);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.externalCampaignId, "12345678");
  });
});

describe("walmart import input builder", () => {
  it("stamps lineage: import batch receipt, no approval", () => {
    const input = buildWalmartImportInput({
      workspaceId: "ws_1",
      accountId: "acct_1",
      csv: WALMART_CSV_TEMPLATE,
      batchId: "batch_42",
    });
    assert.equal(input.platformKey, "walmart");
    assert.equal(input.rows.length, 1);
    assert.equal(input.rows[0]!.platformReceiptId, "import:batch_42");
    assert.equal(input.rows[0]!.approvalId, null);
    assert.equal((input.rows[0]!.raw as { line: number }).line, 2);
  });
});

describe("walmart negatives: nothing executes without an API connector", () => {
  it("launch fails closed with PLATFORM_NOT_CONNECTED (no executor registered)", async () => {
    await assert.rejects(
      runAdsAction(
        { workspaceId: "ws_1", actor: "u", proposals: stubProposals, approvals: stubApprovals },
        "launch",
        { platformKey: "walmart", proposalId: "prop_1" },
      ),
      (e: unknown) => e instanceof AdsActionError && e.code === "PLATFORM_NOT_CONNECTED",
    );
  });

  it("pause and adjust_budget fail closed the same way", async () => {
    for (const slug of ["pause", "adjust_budget"]) {
      await assert.rejects(
        runAdsAction(
          { workspaceId: "ws_1", actor: "u", proposals: stubProposals, approvals: stubApprovals },
          slug,
          { platformKey: "walmart", proposalId: "prop_1" },
        ),
        (e: unknown) => e instanceof AdsActionError && e.code === "PLATFORM_NOT_CONNECTED",
        `expected PLATFORM_NOT_CONNECTED for ${slug}`,
      );
    }
  });
});
