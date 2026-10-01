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
  return {
    async getActivePartners() {
      return partners.filter((p) => p.status === "active");
    },
    async create(_ws, input) {
      validatePartnerInput(input);
      return record({ name: input.name });
    },
    async setStatus() {},
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
