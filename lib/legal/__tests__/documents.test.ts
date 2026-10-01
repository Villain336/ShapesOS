// Marketr — Legal/Compliance slice 3 tests: document vault.
// Run: npx tsx --test lib/legal/__tests__/documents.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DOCUMENT_TYPE_LABELS,
  DOCUMENT_TYPES,
  EXPIRY_SOURCE_LABELS,
  carryForwardExpiry,
  documentAlertBody,
  documentAlertTitle,
  isValidDocumentType,
  isValidExpirySource,
  planNewVersion,
  tierForExpiry,
  type LegalDocumentType,
  type PreviousVersion,
} from "../documents";
import {
  sweepLegalDocumentAlerts,
  type DocumentSweepStore,
  type SweepDocumentVersion,
} from "../document-sweep";
import type { TriggerInput } from "../../alerts/evaluate";
import { LEGAL_DISCLAIMER, LegalError } from "../types";

const DAY_MS = 86_400_000;
// Fixed "now" so boundary tests are deterministic.
const NOW = new Date(Date.UTC(2026, 9, 1, 12, 0, 0)); // 2026-10-01 12:00 UTC

const atDaysOut = (days: number) => new Date(NOW.getTime() + days * DAY_MS);

describe("document types", () => {
  it("accepts only the spec's kinds", () => {
    for (const t of ["formation", "contract", "license", "ein_letter", "policy", "other"] as LegalDocumentType[]) {
      assert.equal(isValidDocumentType(t), true);
      assert.ok(DOCUMENT_TYPE_LABELS[t]);
    }
    assert.equal(isValidDocumentType("driver_license"), false);
    assert.equal(isValidDocumentType(""), false);
    assert.equal(isValidDocumentType(undefined), false);
  });

  it("has labels for every type", () => {
    assert.deepEqual(new Set(DOCUMENT_TYPES), new Set(Object.keys(DOCUMENT_TYPE_LABELS)));
  });

  it("expiry sources are the two tenant-grounded options", () => {
    assert.equal(isValidExpirySource("tenant_set"), true);
    assert.equal(isValidExpirySource("read_from_document"), true);
    assert.equal(isValidExpirySource("guessed"), false);
    assert.ok(EXPIRY_SOURCE_LABELS.tenant_set);
    assert.ok(EXPIRY_SOURCE_LABELS.read_from_document);
  });
});

describe("planNewVersion", () => {
  it("starts at version 1 with no supersedes for a new document", () => {
    assert.deepEqual(planNewVersion(null), {
      versionNumber: 1,
      supersedesVersionId: null,
    });
  });

  it("a new upload of the same document becomes version N+1 superseding the previous one", () => {
    const v1: PreviousVersion = {
      id: "v1",
      versionNumber: 1,
      expiryDate: null,
      expirySource: null,
      issuer: null,
    };
    assert.deepEqual(planNewVersion(v1), {
      versionNumber: 2,
      supersedesVersionId: "v1",
    });

    // Simulate the full chain: three uploads, history intact, each new
    // version supersedes the previous current one.
    const versions: PreviousVersion[] = [];
    let prev: PreviousVersion | null = null;
    for (let i = 0; i < 3; i++) {
      const plan = planNewVersion(prev);
      const v: PreviousVersion = {
        id: `v${plan.versionNumber}`,
        versionNumber: plan.versionNumber,
        expiryDate: null,
        expirySource: null,
        issuer: null,
      };
      versions.push(v);
      prev = v;
    }
    assert.equal(versions.length, 3);
    assert.deepEqual(
      versions.map((v) => v.versionNumber),
      [1, 2, 3],
    );
    assert.equal(versions[1].id, "v2");
    // v3 supersedes v2 (the previous current version).
    const plan3 = planNewVersion(versions[1]);
    assert.equal(plan3.supersedesVersionId, "v2");
    assert.equal(plan3.versionNumber, 3);
  });
});

describe("carryForwardExpiry", () => {
  const prev: PreviousVersion = {
    id: "v1",
    versionNumber: 1,
    expiryDate: "2027-06-01T00:00:00.000Z",
    expirySource: "read_from_document",
    issuer: "State of NC",
  };

  it("a new upload without an expiry carries the previous one forward", () => {
    assert.deepEqual(carryForwardExpiry({ expiryDate: undefined }, prev), {
      expiryDate: "2027-06-01T00:00:00.000Z",
      expirySource: "read_from_document",
    });
  });

  it("an explicit null clears the expiry", () => {
    assert.deepEqual(carryForwardExpiry({ expiryDate: null }, prev), {
      expiryDate: null,
      expirySource: null,
    });
  });

  it("a provided date sets it with the provided source", () => {
    assert.deepEqual(
      carryForwardExpiry(
        { expiryDate: "2027-01-15T00:00:00.000Z", expirySource: "tenant_set" },
        prev,
      ),
      {
        expiryDate: "2027-01-15T00:00:00.000Z",
        expirySource: "tenant_set",
      },
    );
  });

  it("a provided date without a source keeps the previous source", () => {
    const r = carryForwardExpiry(
      { expiryDate: "2027-01-15T00:00:00.000Z" },
      prev,
    );
    assert.equal(r.expirySource, "read_from_document");
  });

  it("no previous version and no date leaves expiry null — never guessed", () => {
    assert.deepEqual(carryForwardExpiry({ expiryDate: undefined }, null), {
      expiryDate: null,
      expirySource: null,
    });
    assert.deepEqual(
      carryForwardExpiry({ expiryDate: undefined, expirySource: undefined }, null),
      { expiryDate: null, expirySource: null },
    );
  });

  it("rejects unparseable dates instead of coercing them", () => {
    assert.throws(
      () => carryForwardExpiry({ expiryDate: "not-a-date" }, null),
      (e: unknown) => e instanceof LegalError && e.code === "INVALID_DATE",
    );
  });

  it("rejects unknown expiry sources", () => {
    assert.throws(
      () =>
        carryForwardExpiry(
          { expiryDate: "2027-01-15", expirySource: "guessed" as never },
          null,
        ),
      (e: unknown) => e instanceof LegalError && e.code === "INVALID_EXPIRY_SOURCE",
    );
  });
});

describe("tierForExpiry", () => {
  it("uses the same escalation ladder as deadlines: 90 → 30 → 7 → overdue", () => {
    assert.equal(tierForExpiry(atDaysOut(90), NOW), "due_90");
    assert.equal(tierForExpiry(atDaysOut(91), NOW), null);
    assert.equal(tierForExpiry(atDaysOut(30), NOW), "due_30");
    assert.equal(tierForExpiry(atDaysOut(31), NOW), "due_90");
    assert.equal(tierForExpiry(atDaysOut(7), NOW), "due_7");
    assert.equal(tierForExpiry(atDaysOut(8), NOW), "due_30");
    assert.equal(tierForExpiry(atDaysOut(-1), NOW), "overdue");
  });

  it("a missing expiry is date_needed — never a guessed date", () => {
    assert.equal(tierForExpiry(null, NOW), "date_needed");
  });
});

describe("document alert copy", () => {
  it("titles carry the tier and the tenant's own title", () => {
    assert.equal(
      documentAlertTitle("Business license", "due_30"),
      "Business license — expires within 30 days",
    );
    assert.equal(
      documentAlertTitle("Business license", "overdue"),
      "Business license — expired",
    );
    assert.equal(
      documentAlertTitle("Business license", "date_needed"),
      "Record an expiry date: Business license",
    );
  });

  it("the date_needed body asks the tenant to record a date — no guess", () => {
    const body = documentAlertBody({
      title: "Business license",
      tier: "date_needed",
      expiryDateText: null,
      daysUntil: null,
    });
    assert.ok(body.includes("no recorded expiry date yet"));
    assert.ok(body.includes("never guessed"));
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(body));
  });

  it("tier bodies render only the tenant's date", () => {
    const body = documentAlertBody({
      title: "Business license",
      tier: "due_30",
      expiryDateText: "Nov 15, 2026",
      daysUntil: 30,
    });
    assert.ok(body.includes("Nov 15, 2026"));
    assert.ok(body.includes("Legal → Documents"));
  });
});

// ------------------------------------------------------------------
// Sweep: fake store + captured emissions (same pattern as slice 2 tests)
// ------------------------------------------------------------------

function makeVersion(
  overrides: Partial<SweepDocumentVersion> = {},
): SweepDocumentVersion {
  return {
    id: "ver-1",
    documentId: "doc-1",
    title: "Business license",
    docType: "license",
    versionNumber: 2,
    expiryDate: atDaysOut(30),
    lastAlertedTier: null,
    ...overrides,
  };
}

function fakeStore(versions: SweepDocumentVersion[]): DocumentSweepStore & {
  recorded: { versionId: string; tier: string }[];
} {
  const recorded: { versionId: string; tier: string }[] = [];
  return {
    recorded,
    async listCurrentVersions() {
      return versions;
    },
    async recordDocumentAlertedTier(_ws, versionId, tier) {
      recorded.push({ versionId, tier });
    },
  };
}

describe("sweepLegalDocumentAlerts", () => {
  it("emits on entering a new tier with the legal_document_expiry trigger", async () => {
    const store = fakeStore([makeVersion()]);
    const emitted: TriggerInput[] = [];
    const emit = async (input: TriggerInput) => {
      emitted.push(input);
    };
    const result = await sweepLegalDocumentAlerts(store, emit, "ws-1", { now: NOW });

    assert.equal(result.emitted, 1);
    assert.equal(result.checked, 1);
    const [input] = emitted;
    assert.equal(input.trigger, "legal_document_expiry");
    assert.equal(input.severity, "warn"); // due_30 → warn
    assert.ok(input.title.includes("Business license"));
    assert.ok(input.body.includes(LEGAL_DISCLAIMER));
    assert.equal(input.dedupKey, "legal_document_expiry:ver-1:due_30");
    assert.deepEqual(store.recorded, [{ versionId: "ver-1", tier: "due_30" }]);
    assert.deepEqual(result.fired, [
      { versionId: "ver-1", documentId: "doc-1", title: "Business license", tier: "due_30" },
    ]);
  });

  it("does not re-emit a tier that was already alerted", async () => {
    const store = fakeStore([makeVersion({ lastAlertedTier: "due_30" })]);
    let count = 0;
    const result = await sweepLegalDocumentAlerts(
      store,
      async () => {
        count += 1;
      },
      "ws-1",
      { now: NOW },
    );
    assert.equal(result.emitted, 0);
    assert.equal(count, 0);
    assert.equal(result.skipped, 1);
  });

  it("emits again when the tier escalates (due_90 → due_30)", async () => {
    const store = fakeStore([
      makeVersion({ id: "ver-a", lastAlertedTier: "due_90", expiryDate: atDaysOut(30) }),
    ]);
    const titles: string[] = [];
    const result = await sweepLegalDocumentAlerts(
      store,
      async (input) => {
        titles.push(input.title);
      },
      "ws-1",
      { now: NOW },
    );
    assert.equal(result.emitted, 1);
    assert.ok(titles[0].includes("expires within 30 days"));
  });

  it("stays silent more than 90 days out", async () => {
    const store = fakeStore([makeVersion({ expiryDate: atDaysOut(120) })]);
    let count = 0;
    const result = await sweepLegalDocumentAlerts(
      store,
      async () => {
        count += 1;
      },
      "ws-1",
      { now: NOW },
    );
    assert.equal(result.emitted, 0);
    assert.equal(count, 0);
  });

  it("emits the date_needed reminder once for a version with no recorded expiry", async () => {
    const store = fakeStore([makeVersion({ expiryDate: null })]);
    const inputs: { title: string; body: string; severity?: string }[] = [];
    const result = await sweepLegalDocumentAlerts(store, async (i) => void inputs.push(i), "ws-1", { now: NOW });
    assert.equal(result.emitted, 1);
    assert.ok(inputs[0].title.startsWith("Record an expiry date:"));
    assert.ok(inputs[0].body.includes("never guessed"));
    assert.equal(inputs[0].severity, "info");

    // A second run does not nag for the same tier.
    const second = await sweepLegalDocumentAlerts(
      fakeStore([makeVersion({ expiryDate: null, lastAlertedTier: "date_needed" })]),
      async () => {
        throw new Error("must not emit");
      },
      "ws-1",
      { now: NOW },
    );
    assert.equal(second.emitted, 0);
  });

  it("escalates severity like deadlines: due_7 critical, overdue critical", async () => {
    const severities: (string | undefined)[] = [];
    const store = fakeStore([
      makeVersion({ id: "v7", expiryDate: atDaysOut(7) }),
      makeVersion({ id: "vo", expiryDate: atDaysOut(-3) }),
    ]);
    await sweepLegalDocumentAlerts(
      store,
      async (input) => {
        severities.push(input.severity);
      },
      "ws-1",
      { now: NOW },
    );
    assert.deepEqual(severities, ["critical", "critical"]);
  });
});
