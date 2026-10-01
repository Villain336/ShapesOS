// Marketr — Wave 2 Insurance partner tests: licensed-partner producer-of-record.
// Run: npx tsx --test lib/insurance/__tests__/partner.test.ts
//
// Stub store throughout: no database. Proves the LICENSED PARTNER model
// (Tico 2026-10-01): registration is fail-closed on license identity, and the
// bind gate throws PARTNER_NOT_APPOINTED unless an active, appointed partner
// is on file — never a silent skip.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  assertPartnerAppointed,
  partnerCoversState,
  requireAppointedPartner,
  validatePartnerInput,
  validatePartnerStates,
  type LicensedPartnerInput,
  type LicensedPartnerRecord,
  type LicensedPartnerStore,
} from "../partner";
import { InsuranceError } from "../types";

const GOOD_INPUT: LicensedPartnerInput = {
  name: "Amwins DAIS Partner LLC",
  contactEmail: "partners@example.com",
  licenseNumber: "NC-123456",
  statesLicensed: ["NC", "SC"],
  appointmentPath: "dais_market_access",
};

function record(overrides: Partial<LicensedPartnerRecord> = {}): LicensedPartnerRecord {
  return {
    id: "partner-1",
    workspaceId: "ws-1",
    name: "Amwins DAIS Partner LLC",
    contactEmail: null,
    licenseNumber: "NC-123456",
    statesLicensed: ["NC", "SC"],
    appointmentPath: "dais_market_access",
    status: "active",
    appointedAt: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  };
}

function stubStore(partners: LicensedPartnerRecord[]): LicensedPartnerStore {
  const byId = new Map(partners.map((p) => [p.id, { ...p }]));
  return {
    async getActivePartners() {
      return [...byId.values()].filter((p) => p.status === "active");
    },
    async list() {
      return [...byId.values()];
    },
    async get(_ws, partnerId) {
      return byId.get(partnerId) ?? null;
    },
    async create(_ws, input) {
      validatePartnerInput(input);
      const p = record({ name: input.name });
      byId.set(p.id, p);
      return p;
    },
    async setStatus(_ws, partnerId, status) {
      const p = byId.get(partnerId);
      if (!p) {
        throw new InsuranceError("UNKNOWN_PARTNER", "Licensed partner not found in this workspace.");
      }
      p.status = status;
    },
    async setLicensedStates(_ws, partnerId, states) {
      const p = byId.get(partnerId);
      if (!p) {
        throw new InsuranceError("UNKNOWN_PARTNER", "Licensed partner not found in this workspace.");
      }
      // Mirror the fail-closed state validation the Prisma store applies.
      p.statesLicensed = validatePartnerStates(states);
      return p;
    },
  };
}

describe("partner registration (fail closed on license identity)", () => {
  it("accepts a complete partner", () => {
    validatePartnerInput(GOOD_INPUT);
  });
  it("rejects a blank name", () => {
    assert.throws(
      () => validatePartnerInput({ ...GOOD_INPUT, name: "  " }),
      (e: unknown) => e instanceof InsuranceError && e.code === "PARTNER_NAME_REQUIRED",
    );
  });
  it("rejects empty licensed states", () => {
    assert.throws(
      () => validatePartnerInput({ ...GOOD_INPUT, statesLicensed: [] }),
      (e: unknown) => e instanceof InsuranceError && e.code === "PARTNER_STATES_REQUIRED",
    );
  });
  it("rejects malformed state codes", () => {
    assert.throws(
      () => validatePartnerInput({ ...GOOD_INPUT, statesLicensed: ["North Carolina"] }),
      (e: unknown) => e instanceof InsuranceError && e.code === "BAD_PARTNER_STATE",
    );
  });
  it("rejects a missing license number — a partner without license identity cannot satisfy the gate", () => {
    assert.throws(
      () => validatePartnerInput({ ...GOOD_INPUT, licenseNumber: "" }),
      (e: unknown) => e instanceof InsuranceError && e.code === "PARTNER_LICENSE_REQUIRED",
    );
  });
});

describe("assertPartnerAppointed (the bind gate)", () => {
  it("returns the active, appointed partner", () => {
    const p = assertPartnerAppointed([record()]);
    assert.equal(p.id, "partner-1");
  });
  it("throws PARTNER_NOT_APPOINTED when no partners exist", () => {
    assert.throws(
      () => assertPartnerAppointed([]),
      (e: unknown) => e instanceof InsuranceError && e.code === "PARTNER_NOT_APPOINTED",
    );
  });
  it("throws when the only partner is suspended", () => {
    assert.throws(
      () => assertPartnerAppointed([record({ status: "suspended" })]),
      (e: unknown) => e instanceof InsuranceError && e.code === "PARTNER_NOT_APPOINTED",
    );
  });
  it("throws when the only partner is revoked", () => {
    assert.throws(
      () => assertPartnerAppointed([record({ status: "revoked" })]),
      (e: unknown) => e instanceof InsuranceError && e.code === "PARTNER_NOT_APPOINTED",
    );
  });
  it("throws when the partner was never marked appointed", () => {
    assert.throws(
      () => assertPartnerAppointed([record({ appointedAt: null })]),
      (e: unknown) => e instanceof InsuranceError && e.code === "PARTNER_NOT_APPOINTED",
    );
  });
});

describe("partnerCoversState", () => {
  it("matches case-insensitively", () => {
    assert.equal(partnerCoversState(record(), "nc"), true);
    assert.equal(partnerCoversState(record(), "GA"), false);
  });
});

describe("requireAppointedPartner (store-backed gate)", () => {
  it("resolves the appointed partner from the store", async () => {
    const p = await requireAppointedPartner("ws-1", stubStore([record()]));
    assert.equal(p.id, "partner-1");
  });
  it("fails closed when the store has no active partners", async () => {
    await assert.rejects(
      () => requireAppointedPartner("ws-1", stubStore([])),
      (e: unknown) => e instanceof InsuranceError && e.code === "PARTNER_NOT_APPOINTED",
    );
  });
  it("fails closed when the store's partners are all suspended", async () => {
    await assert.rejects(
      () =>
        requireAppointedPartner(
          "ws-1",
          stubStore([record({ status: "suspended" })]),
        ),
      (e: unknown) => e instanceof InsuranceError && e.code === "PARTNER_NOT_APPOINTED",
    );
  });
});

describe("validatePartnerStates (fail closed on state codes)", () => {
  it("uppercases and trims codes", () => {
    assert.deepEqual(validatePartnerStates(["nc", " Sc "]), ["NC", "SC"]);
  });
  it("rejects an empty list", () => {
    assert.throws(
      () => validatePartnerStates([]),
      (e: unknown) => e instanceof InsuranceError && e.code === "PARTNER_STATES_REQUIRED",
    );
  });
  it("rejects a malformed code", () => {
    assert.throws(
      () => validatePartnerStates(["NCA"]),
      (e: unknown) => e instanceof InsuranceError && e.code === "BAD_PARTNER_STATE",
    );
  });
});

describe("partner management surface (slice 3c store methods)", () => {
  it("list returns every partner, active or not", async () => {
    const store = stubStore([
      record(),
      record({ id: "partner-2", status: "suspended", name: "Other" }),
    ]);
    const all = await store.list("ws-1");
    assert.equal(all.length, 2);
  });
  it("get returns the partner by id, null when unknown", async () => {
    const store = stubStore([record()]);
    assert.equal((await store.get("ws-1", "partner-1"))?.name, "Amwins DAIS Partner LLC");
    assert.equal(await store.get("ws-1", "nope"), null);
  });
  it("setLicensedStates replaces the state list, normalized", async () => {
    const store = stubStore([record()]);
    const updated = await store.setLicensedStates("ws-1", "partner-1", ["ga", "FL"]);
    assert.deepEqual(updated.statesLicensed, ["GA", "FL"]);
  });
  it("setLicensedStates fails closed on malformed codes", async () => {
    const store = stubStore([record()]);
    await assert.rejects(
      () => store.setLicensedStates("ws-1", "partner-1", ["North Carolina"]),
      (e: unknown) => e instanceof InsuranceError && e.code === "BAD_PARTNER_STATE",
    );
  });
  it("setStatus to an unknown partner fails closed", async () => {
    const store = stubStore([record()]);
    await assert.rejects(
      () => store.setStatus("ws-1", "nope", "suspended"),
      (e: unknown) => e instanceof InsuranceError && e.code === "UNKNOWN_PARTNER",
    );
  });
  it("suspending the only partner re-blocks the bind gate", async () => {
    const store = stubStore([record()]);
    // Gate is satisfied before the suspension…
    await requireAppointedPartner("ws-1", store);
    // …and fails closed after.
    await store.setStatus("ws-1", "partner-1", "suspended");
    await assert.rejects(
      () => requireAppointedPartner("ws-1", store),
      (e: unknown) => e instanceof InsuranceError && e.code === "PARTNER_NOT_APPOINTED",
    );
  });
});
