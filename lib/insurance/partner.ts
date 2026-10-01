// Marketr — Wave 2 Insurance: licensed-partner producer-of-record.
//
// Tico's decision (2026-10-01): LICENSED PARTNER model — the partner holds
// the insurance licenses, Marketr provides the software. Consequences:
//
// - No bind may execute unless an ACTIVE, appointed licensed partner is on
//   file for the workspace. The bind path fails closed with
//   PARTNER_NOT_APPOINTED otherwise — never a silent skip.
// - Quote / propose / approval flows are unaffected: quotes are non-binding
//   and approvals are human decisions; only execution needs the partner.
// - An active partner must name a license number and at least one licensed
//   state — a partner record without license identity cannot satisfy the gate.
//
// This file is persistence-agnostic: pure rules plus a store port (Prisma
// default, stubs in tests).

import { InsuranceError } from "./types";
import type { InsuranceAppointmentPath } from "./types";
import { prisma } from "@/lib/prisma";

export type LicensedPartnerStatus = "active" | "suspended" | "revoked";

export const LICENSED_PARTNER_STATUSES: readonly LicensedPartnerStatus[] = [
  "active",
  "suspended",
  "revoked",
];

export interface LicensedPartnerRecord {
  id: string;
  workspaceId: string;
  name: string;
  contactEmail: string | null;
  licenseNumber: string | null;
  statesLicensed: string[];
  appointmentPath: InsuranceAppointmentPath;
  status: LicensedPartnerStatus;
  appointedAt: Date | null;
}

export interface LicensedPartnerInput {
  name: string;
  contactEmail?: string;
  licenseNumber?: string;
  statesLicensed: string[];
  appointmentPath: InsuranceAppointmentPath;
  notes?: string;
}

/**
 * Validate + normalize licensed-state codes (2-letter, uppercased). Fail
 * closed: a malformed state code throws BAD_PARTNER_STATE. Returns the
 * normalized codes.
 */
export function validatePartnerStates(states: unknown): string[] {
  if (!Array.isArray(states) || states.length === 0) {
    throw new InsuranceError(
      "PARTNER_STATES_REQUIRED",
      "At least one licensed state is required (2-letter codes).",
    );
  }
  return states.map((s) => {
    const code = String(s).trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) {
      throw new InsuranceError(
        "BAD_PARTNER_STATE",
        `Licensed states must be 2-letter codes; got "${s}".`,
      );
    }
    return code;
  });
}

/**
 * Fail closed on partner registration: an appointed partner is a legal
 * identity, so the record must carry one. A partner without a license number
 * or licensed states can be stored as suspended, never as active.
 */
export function validatePartnerInput(input: LicensedPartnerInput): void {
  if (!input.name || input.name.trim().length === 0) {
    throw new InsuranceError("PARTNER_NAME_REQUIRED", "Partner name is required.");
  }
  validatePartnerStates(input.statesLicensed);
  if (!input.licenseNumber || input.licenseNumber.trim().length === 0) {
    throw new InsuranceError(
      "PARTNER_LICENSE_REQUIRED",
      "An active partner must carry a producer license number.",
    );
  }
}

/**
 * The bind gate. Returns the appointed partner for the workspace, or throws
 * PARTNER_NOT_APPOINTED — the bind/execute path must treat this as a hard
 * stop, never a skip. Suspended and revoked partners do not satisfy the gate.
 */
export function assertPartnerAppointed(
  partners: LicensedPartnerRecord[],
): LicensedPartnerRecord {
  const appointed = partners.find(
    (p) => p.status === "active" && p.appointedAt !== null,
  );
  if (!appointed) {
    throw new InsuranceError(
      "PARTNER_NOT_APPOINTED",
      "No active licensed partner is appointed for this workspace. " +
        "Binding is blocked until a licensed partner (name, producer license " +
        "number, licensed states) is registered and marked appointed.",
    );
  }
  return appointed;
}

/** True when the partner may bind in the given state. */
export function partnerCoversState(
  partner: LicensedPartnerRecord,
  state: string,
): boolean {
  return partner.statesLicensed
    .map((s) => s.toUpperCase())
    .includes(state.trim().toUpperCase());
}

// ---------------------------------------------------------------------------
// Store port.
// ---------------------------------------------------------------------------

export interface LicensedPartnerStore {
  getActivePartners(workspaceId: string): Promise<LicensedPartnerRecord[]>;
  /** All partners in the workspace, newest first (management surface). */
  list(workspaceId: string): Promise<LicensedPartnerRecord[]>;
  get(workspaceId: string, partnerId: string): Promise<LicensedPartnerRecord | null>;
  create(
    workspaceId: string,
    input: LicensedPartnerInput,
  ): Promise<LicensedPartnerRecord>;
  setStatus(
    workspaceId: string,
    partnerId: string,
    status: LicensedPartnerStatus,
  ): Promise<void>;
  /** Replace the licensed-states list (validated 2-letter codes). */
  setLicensedStates(
    workspaceId: string,
    partnerId: string,
    states: string[],
  ): Promise<LicensedPartnerRecord>;
}

function toRecord(row: {
  id: string;
  workspaceId: string;
  name: string;
  contactEmail: string | null;
  licenseNumber: string | null;
  statesLicensed: unknown;
  appointmentPath: InsuranceAppointmentPath;
  status: LicensedPartnerStatus;
  appointedAt: Date | null;
}): LicensedPartnerRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    contactEmail: row.contactEmail,
    licenseNumber: row.licenseNumber,
    statesLicensed: Array.isArray(row.statesLicensed)
      ? (row.statesLicensed as string[])
      : [],
    appointmentPath: row.appointmentPath,
    status: row.status,
    appointedAt: row.appointedAt,
  };
}

export function prismaLicensedPartnerStore(): LicensedPartnerStore {
  return {
    async getActivePartners(workspaceId) {
      const rows = await prisma.insuranceLicensedPartner.findMany({
        where: { workspaceId, status: "active" },
        orderBy: { appointedAt: "desc" },
      });
      return rows.map((r) =>
        toRecord({
          ...r,
          appointmentPath: r.appointmentPath as InsuranceAppointmentPath,
          status: r.status as LicensedPartnerStatus,
        }),
      );
    },
    async list(workspaceId) {
      const rows = await prisma.insuranceLicensedPartner.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "desc" },
      });
      return rows.map((r) =>
        toRecord({
          ...r,
          appointmentPath: r.appointmentPath as InsuranceAppointmentPath,
          status: r.status as LicensedPartnerStatus,
        }),
      );
    },
    async get(workspaceId, partnerId) {
      const r = await prisma.insuranceLicensedPartner.findFirst({
        where: { id: partnerId, workspaceId },
      });
      return r
        ? toRecord({
            ...r,
            appointmentPath: r.appointmentPath as InsuranceAppointmentPath,
            status: r.status as LicensedPartnerStatus,
          })
        : null;
    },
    async create(workspaceId, input) {
      validatePartnerInput(input);
      const row = await prisma.insuranceLicensedPartner.create({
        data: {
          workspaceId,
          name: input.name.trim(),
          contactEmail: input.contactEmail?.trim() || null,
          licenseNumber: input.licenseNumber!.trim(),
          statesLicensed: input.statesLicensed.map((s) => s.trim().toUpperCase()),
          appointmentPath: input.appointmentPath,
          status: "active",
          appointedAt: new Date(),
          notes: input.notes?.trim() || null,
        },
      });
      return toRecord({
        ...row,
        appointmentPath: row.appointmentPath as InsuranceAppointmentPath,
        status: row.status as LicensedPartnerStatus,
      });
    },
    async setStatus(workspaceId, partnerId, status) {
      const updated = await prisma.insuranceLicensedPartner.updateMany({
        where: { id: partnerId, workspaceId },
        data: {
          status,
          appointedAt: status === "active" ? new Date() : null,
        },
      });
      if (updated.count === 0) {
        throw new InsuranceError("UNKNOWN_PARTNER", "Licensed partner not found in this workspace.");
      }
    },
    async setLicensedStates(workspaceId, partnerId, states) {
      const normalized = validatePartnerStates(states);
      const updated = await prisma.insuranceLicensedPartner.updateMany({
        where: { id: partnerId, workspaceId },
        data: { statesLicensed: normalized },
      });
      if (updated.count === 0) {
        throw new InsuranceError("UNKNOWN_PARTNER", "Licensed partner not found in this workspace.");
      }
      const r = await prisma.insuranceLicensedPartner.findFirst({
        where: { id: partnerId, workspaceId },
      });
      if (!r) {
        throw new InsuranceError("UNKNOWN_PARTNER", "Licensed partner not found in this workspace.");
      }
      return toRecord({
        ...r,
        appointmentPath: r.appointmentPath as InsuranceAppointmentPath,
        status: r.status as LicensedPartnerStatus,
      });
    },
  };
}

/** JSON-safe serialization for API responses. */
export function serializePartner(record: LicensedPartnerRecord): Record<string, unknown> {
  return {
    id: record.id,
    name: record.name,
    contactEmail: record.contactEmail,
    licenseNumber: record.licenseNumber,
    licensedStates: record.statesLicensed,
    appointmentPath: record.appointmentPath,
    status: record.status,
    appointedAt: record.appointedAt ? record.appointedAt.toISOString() : null,
  };
}

/**
 * Convenience for the bind/execute path: load + assert in one call.
 * Throws PARTNER_NOT_APPOINTED when the workspace has no appointed partner.
 */
export async function requireAppointedPartner(
  workspaceId: string,
  store: LicensedPartnerStore = prismaLicensedPartnerStore(),
): Promise<LicensedPartnerRecord> {
  const partners = await store.getActivePartners(workspaceId);
  return assertPartnerAppointed(partners);
}
