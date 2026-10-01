// Marketr — Phase 18 slice 5 tests: Spotify guided flow + spend import.
// Run: npx tsx --test lib/adplatforms/spotify/__tests__/guided.test.ts
//
// Pure: registry flags, checklist data integrity, the budget planner, the
// UTM builder, the creative spec checker, the CSV parser, the import input
// builder, and the fail-closed negatives (launch never executes for a
// guided platform). No DB, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ADS_PLATFORMS } from "../../types";
import { runAdsAction, AdsActionError } from "../../actions";
import type { SpendApprovalStore, SpendProposalStore } from "../../gate";
import {
  SpotifyGuidedError,
  SPOTIFY_GUIDED_STEPS,
  SPOTIFY_MIN_BUDGET_USD,
  SPOTIFY_AUDIO_SPECS,
  SPOTIFY_CSV_COLUMNS,
  SPOTIFY_CSV_TEMPLATE,
  SPOTIFY_PIXEL_TEMPLATE,
  planSpotifyBudget,
  checkSpotifyAudioCreative,
  buildSpotifyUtmUrl,
  parseSpotifySpendCsv,
  buildSpotifyImportInput,
} from "../guided";

const stubProposals = {
  create: () => Promise.reject(new Error("must not be called")),
  get: () => Promise.resolve(null),
} as unknown as SpendProposalStore;
const stubApprovals = {
  create: () => Promise.reject(new Error("must not be called")),
  getByProposalId: () => Promise.resolve(null),
} as unknown as SpendApprovalStore;

describe("spotify registry: guided-only by design (spec §2d)", () => {
  it("registers spotify as guided with no API claims", () => {
    const def = ADS_PLATFORMS.spotify;
    assert.equal(def.authKind, "guided");
    assert.equal(def.guidedOnly, true);
    assert.equal(def.supportsApiLaunch, false);
    assert.equal(def.supportsReportingApi, false);
    assert.equal(def.oauthConnectorKey, undefined);
  });
});

describe("spotify guided checklist integrity", () => {
  it("has unique step ids and complete copy", () => {
    const ids = SPOTIFY_GUIDED_STEPS.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const s of SPOTIFY_GUIDED_STEPS) {
      assert.ok(s.title.length > 0, `step ${s.id} needs a title`);
      assert.ok(s.detail.length > 20, `step ${s.id} needs a real description`);
    }
  });

  it("walks the Ads Manager self-serve path (business email, ad account, billing)", () => {
    const joined = SPOTIFY_GUIDED_STEPS.map((s) => `${s.title} ${s.detail}`).join(" ");
    assert.match(joined, /business email/);
    assert.match(joined, /\+Ad accounts|ad accounts/i);
    assert.match(joined, /billing/i);
  });

  it("never claims API control — Marketr tracks, the user launches", () => {
    const joined = SPOTIFY_GUIDED_STEPS.map((s) => `${s.title} ${s.detail}`).join(" ");
    assert.doesNotMatch(joined, /Marketr launches/i);
    assert.match(joined, /Marketr/i);
  });

  it("links to Spotify's official getting-started help center", () => {
    const account = SPOTIFY_GUIDED_STEPS.find((s) => s.id === "spotify-account");
    assert.ok(account?.link?.href.includes("ads.spotify.com"), "account step links the official help center");
  });
});

describe("spotify budget planner ($250 floor)", () => {
  it("flags budgets below the $250 minimum as not launchable", () => {
    const plan = planSpotifyBudget({ budgetUsd: 249.99 });
    assert.equal(plan.ok, false);
    assert.equal(plan.belowMinimum, true);
    assert.equal(plan.minimumUsd, 250);
    assert.equal(SPOTIFY_MIN_BUDGET_USD, 250);
    assert.ok(plan.notes.some((n) => /\$250/.test(n) && /cannot launch/i.test(n)));
  });

  it("accepts exactly $250 and computes the daily estimate", () => {
    const plan = planSpotifyBudget({ budgetUsd: 250, startDate: "2026-10-01", endDate: "2026-10-10" });
    assert.equal(plan.ok, true);
    assert.equal(plan.belowMinimum, false);
    assert.equal(plan.budgetCents, 25000);
    assert.equal(plan.flightDays, 10);
    assert.equal(plan.estimatedDailyUsd, 25);
  });

  it("computes inclusive flight days and warns on a reversed flight", () => {
    const plan = planSpotifyBudget({ budgetUsd: 500, startDate: "2026-10-10", endDate: "2026-10-01" });
    assert.equal(plan.flightDays, null);
    assert.ok(plan.notes.some((n) => /before the start date/i.test(n)));
  });

  it("notes an invalid date instead of crashing the planner", () => {
    const plan = planSpotifyBudget({ budgetUsd: 500, startDate: "2026-02-30" });
    assert.equal(plan.flightDays, null);
    assert.equal(plan.estimatedDailyUsd, null);
    assert.ok(plan.notes.some((n) => /YYYY-MM-DD/.test(n)));
  });

  it("rejects non-positive budgets", () => {
    assert.throws(
      () => planSpotifyBudget({ budgetUsd: 0 }),
      (e: unknown) => e instanceof SpotifyGuidedError && e.code === "INVALID_BUDGET",
    );
    assert.throws(
      () => planSpotifyBudget({ budgetUsd: NaN }),
      (e: unknown) => e instanceof SpotifyGuidedError && e.code === "INVALID_BUDGET",
    );
  });

  it("mentions the StackAdapt programmatic alternative honestly", () => {
    const plan = planSpotifyBudget({ budgetUsd: 500 });
    assert.ok(plan.notes.some((n) => /StackAdapt/.test(n) && /programmatic/i.test(n)));
  });
});

describe("spotify UTM builder", () => {
  it("builds a tagged URL with utm_source=spotify fixed", () => {
    const url = buildSpotifyUtmUrl({ baseUrl: "https://acme.com/lp", campaign: "q4-audio-test" });
    const u = new URL(url);
    assert.equal(u.searchParams.get("utm_source"), "spotify");
    assert.equal(u.searchParams.get("utm_medium"), "audio");
    assert.equal(u.searchParams.get("utm_campaign"), "q4-audio-test");
    assert.equal(u.origin + u.pathname, "https://acme.com/lp");
  });

  it("accepts a custom medium and content, and preserves existing params", () => {
    const url = buildSpotifyUtmUrl({
      baseUrl: "https://acme.com/lp?ref=podcast",
      campaign: "q4-audio-test",
      medium: "podcast",
      content: "30s-version-a",
    });
    const u = new URL(url);
    assert.equal(u.searchParams.get("utm_medium"), "podcast");
    assert.equal(u.searchParams.get("utm_content"), "30s-version-a");
    assert.equal(u.searchParams.get("ref"), "podcast");
  });

  it("encodes special characters in the campaign name", () => {
    const url = buildSpotifyUtmUrl({ baseUrl: "https://acme.com/", campaign: "Q4 audio & video test" });
    // URLSearchParams encodes spaces as + and & as %26.
    assert.ok(url.includes("utm_campaign=Q4+audio+%26+video+test"));
  });

  it("rejects an empty campaign and a non-absolute URL", () => {
    assert.throws(
      () => buildSpotifyUtmUrl({ baseUrl: "https://acme.com/", campaign: "  " }),
      (e: unknown) => e instanceof SpotifyGuidedError && e.code === "INVALID_UTM",
    );
    assert.throws(
      () => buildSpotifyUtmUrl({ baseUrl: "not-a-url", campaign: "q4" }),
      (e: unknown) => e instanceof SpotifyGuidedError && e.code === "INVALID_UTM",
    );
  });
});

describe("spotify audio creative spec checker", () => {
  const GOOD = {
    fileName: "ad.mp3",
    fileSizeBytes: 800 * 1024,
    durationSeconds: 30,
    imageWidth: 640,
    imageHeight: 640,
    imageExt: "jpg",
    imageSizeBytes: 150 * 1024,
    scriptWords: 60,
  };

  function byRule(checks: ReturnType<typeof checkSpotifyAudioCreative>, rule: string) {
    const c = checks.find((x) => x.rule === rule);
    assert.ok(c, `expected a "${rule}" check`);
    return c!;
  }

  it("passes a spec-compliant creative on every checkable rule", () => {
    const checks = checkSpotifyAudioCreative(GOOD);
    assert.equal(checks.length, 8);
    for (const c of checks) {
      assert.equal(c.pass, true, `expected pass: ${c.rule}`);
    }
  });

  it("fails the wrong audio extension, oversize audio, and long duration", () => {
    const checks = checkSpotifyAudioCreative({
      ...GOOD,
      fileName: "ad.m4a",
      fileSizeBytes: 2 * 1024 * 1024,
      durationSeconds: 31,
    });
    assert.equal(byRule(checks, "Audio format").pass, false);
    assert.equal(byRule(checks, "Audio file size").pass, false);
    assert.equal(byRule(checks, "Audio duration").pass, false);
  });

  it("fails non-square, undersized, wrong-format, and oversize companion images", () => {
    const checks = checkSpotifyAudioCreative({
      ...GOOD,
      imageWidth: 640,
      imageHeight: 480,
      imageExt: "gif",
      imageSizeBytes: 300 * 1024,
    });
    assert.equal(byRule(checks, "Companion image is square").pass, false);
    assert.equal(byRule(checks, "Companion image size").pass, false);
    assert.equal(byRule(checks, "Companion image format").pass, false);
    assert.equal(byRule(checks, "Companion image file size").pass, false);
  });

  it("fails an over-long script", () => {
    const checks = checkSpotifyAudioCreative({ ...GOOD, scriptWords: 80 });
    assert.equal(byRule(checks, "Script length").pass, false);
  });

  it("reports pass:null (never assumed) for info the user didn't provide", () => {
    const checks = checkSpotifyAudioCreative({
      ...GOOD,
      durationSeconds: null,
      imageWidth: null,
      imageHeight: null,
      imageSizeBytes: null,
      scriptWords: null,
    });
    for (const rule of [
      "Audio duration",
      "Companion image is square",
      "Companion image size",
      "Companion image file size",
      "Script length",
    ]) {
      const c = byRule(checks, rule);
      assert.equal(c.pass, null, `expected pass:null for "${rule}"`);
      assert.match(c.detail, /not provided/i);
    }
    // What IS provided still passes.
    assert.equal(byRule(checks, "Audio format").pass, true);
  });
});

describe("spotify audio specs data", () => {
  it("documents the 30s / 1MB / WAV-MP3-OGG audio spec with a source", () => {
    const audio = SPOTIFY_AUDIO_SPECS.find((s) => s.asset === "Audio ad file");
    assert.ok(audio, "audio spec group must exist");
    assert.ok(audio!.source.includes("ads.spotify.com"));
    assert.match(audio!.specs.join(" "), /30 seconds or less/);
    assert.match(audio!.specs.join(" "), /WAV, MP3, OGG/);
    assert.match(audio!.specs.join(" "), /1 MB/);
  });

  it("documents the 640px / 200KB companion image spec", () => {
    const image = SPOTIFY_AUDIO_SPECS.find((s) => s.asset === "Companion image");
    assert.ok(image, "companion image spec group must exist");
    assert.match(image!.specs.join(" "), /640/);
    assert.match(image!.specs.join(" "), /200 KB/);
  });

  it("ships the pixel template as a marked reference, not the canonical snippet", () => {
    assert.match(SPOTIFY_PIXEL_TEMPLATE, /REFERENCE TEMPLATE/);
    assert.match(SPOTIFY_PIXEL_TEMPLATE, /PIXEL_ID/);
    assert.match(SPOTIFY_PIXEL_TEMPLATE, /pixel\.spotify\.com/);
    assert.match(SPOTIFY_PIXEL_TEMPLATE, /spotify\('track', 'Purchase'/);
  });
});

describe("spotify spend CSV parser", () => {
  const VALID = [
    "campaign_external_id,date,spend_cents,impressions,clicks,conversions,revenue_cents",
    "sp_9f3a2c,2026-09-28,12500,8421,312,9,74900",
    "sp_77aa10,2026-09-28,0,0,0,0,0",
  ].join("\n");

  it("parses a valid CSV and computes CTR", () => {
    const rows = parseSpotifySpendCsv(VALID);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.externalCampaignId, "sp_9f3a2c");
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
    const rows = parseSpotifySpendCsv(`\uFEFF${VALID}\n\n   \n`);
    assert.equal(rows.length, 2);
  });

  it("parses quoted fields containing commas", () => {
    const rows = parseSpotifySpendCsv(
      `${SPOTIFY_CSV_COLUMNS.join(",")}\n"sp_9f,3a2c",2026-09-28,100,10,1,0,500\n`,
    );
    assert.equal(rows[0]!.externalCampaignId, "sp_9f,3a2c");
  });

  it("rejects a missing required column", () => {
    assert.throws(
      () => parseSpotifySpendCsv("campaign_external_id,date\nsp_9f3a2c,2026-09-28\n"),
      (e: unknown) => e instanceof SpotifyGuidedError && e.code === "CSV_BAD_HEADER",
    );
  });

  it("rejects a ragged row with the line number", () => {
    assert.throws(
      () => parseSpotifySpendCsv(`${SPOTIFY_CSV_COLUMNS.join(",")}\nsp_9f3a2c,2026-09-28,100\n`),
      (e: unknown) =>
        e instanceof SpotifyGuidedError && e.code === "CSV_BAD_ROW" && /Line 2/.test(e.message),
    );
  });

  it("rejects malformed and impossible dates with the line number", () => {
    assert.throws(
      () => parseSpotifySpendCsv(`${SPOTIFY_CSV_COLUMNS.join(",")}\nsp_9f3a2c,09/28/2026,100,10,1,0,500\n`),
      (e: unknown) => e instanceof SpotifyGuidedError && e.code === "CSV_INVALID_DATE",
    );
    assert.throws(
      () => parseSpotifySpendCsv(`${SPOTIFY_CSV_COLUMNS.join(",")}\nsp_9f3a2c,2026-02-30,100,10,1,0,500\n`),
      (e: unknown) =>
        e instanceof SpotifyGuidedError && e.code === "CSV_INVALID_DATE" && /not a real/.test(e.message),
    );
  });

  it("rejects negative and decimal money/counters", () => {
    const base = (spend: string) =>
      `${SPOTIFY_CSV_COLUMNS.join(",")}\nsp_9f3a2c,2026-09-28,${spend},10,1,0,500\n`;
    assert.throws(() => parseSpotifySpendCsv(base("-5")), (e: unknown) => e instanceof SpotifyGuidedError && e.code === "CSV_INVALID_NUMBER");
    assert.throws(() => parseSpotifySpendCsv(base("12.5")), (e: unknown) => e instanceof SpotifyGuidedError && e.code === "CSV_INVALID_NUMBER");
    assert.throws(() => parseSpotifySpendCsv(base("abc")), (e: unknown) => e instanceof SpotifyGuidedError && e.code === "CSV_INVALID_NUMBER");
  });

  it("rejects empty input and header-only input", () => {
    assert.throws(() => parseSpotifySpendCsv("   \n"), (e: unknown) => e instanceof SpotifyGuidedError && e.code === "CSV_EMPTY");
    assert.throws(
      () => parseSpotifySpendCsv(`${SPOTIFY_CSV_COLUMNS.join(",")}\n`),
      (e: unknown) => e instanceof SpotifyGuidedError && e.code === "CSV_EMPTY",
    );
  });

  it("rejects a blank campaign id", () => {
    assert.throws(
      () => parseSpotifySpendCsv(`${SPOTIFY_CSV_COLUMNS.join(",")}\n ,2026-09-28,100,10,1,0,500\n`),
      (e: unknown) => e instanceof SpotifyGuidedError && e.code === "CSV_BAD_ROW",
    );
  });

  it("the shipped template parses cleanly", () => {
    const rows = parseSpotifySpendCsv(SPOTIFY_CSV_TEMPLATE);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.externalCampaignId, "sp_9f3a2c");
  });
});

describe("spotify import input builder", () => {
  it("stamps lineage: import batch receipt, no approval", () => {
    const input = buildSpotifyImportInput({
      workspaceId: "ws_1",
      accountId: "acct_1",
      csv: SPOTIFY_CSV_TEMPLATE,
      batchId: "batch_42",
    });
    assert.equal(input.platformKey, "spotify");
    assert.equal(input.rows.length, 1);
    assert.equal(input.rows[0]!.platformReceiptId, "import:batch_42");
    assert.equal(input.rows[0]!.approvalId, null);
    assert.equal((input.rows[0]!.raw as { line: number }).line, 2);
  });
});

describe("spotify negatives: nothing executes without an API connector", () => {
  it("launch fails closed with PLATFORM_NOT_CONNECTED (no executor registered)", async () => {
    await assert.rejects(
      runAdsAction(
        { workspaceId: "ws_1", actor: "u", proposals: stubProposals, approvals: stubApprovals },
        "launch",
        { platformKey: "spotify", proposalId: "prop_1" },
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
          { platformKey: "spotify", proposalId: "prop_1" },
        ),
        (e: unknown) => e instanceof AdsActionError && e.code === "PLATFORM_NOT_CONNECTED",
        `expected PLATFORM_NOT_CONNECTED for ${slug}`,
      );
    }
  });
});
