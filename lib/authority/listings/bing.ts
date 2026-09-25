// Marketr — Phase 6 L1: Bing Places trusted-partner application flow tracker.
//
// Spec §2/L1: email partneronbp@microsoft.com, sandbox first, then
// production — the lightest major-channel gate. Bulk NAP/hours/photo sync
// via API once approved. No native reviews (see tiers.ts).

export type BingApplicationState =
  | "not_started"
  | "applied"        // application email sent to partneronbp@microsoft.com
  | "sandbox"        // sandbox credentials issued; testing sync
  | "production"     // production API approved; bulk sync live
  | "rejected";

export const BING_APPLICATION_STATES: BingApplicationState[] = [
  "not_started", "applied", "sandbox", "production", "rejected",
];

export const BING_APPLICATION_COPY =
  "Bing Places trusted-partner application: email partneronbp@microsoft.com, sandbox first, then production. " +
  "Free GBP import exists (rebuilt Oct 2025).";

export interface BingApplicationRecord {
  workspaceId: string;
  state: BingApplicationState;
  appliedAt: Date | null;
  sandboxAt: Date | null;
  productionAt: Date | null;
  notes: string[];
  updatedAt: Date;
}

export class BingApplicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BingApplicationError";
  }
}

const TRANSITIONS: Record<BingApplicationState, BingApplicationState[]> = {
  not_started: ["applied"],
  applied: ["sandbox", "rejected", "not_started"],
  sandbox: ["production", "rejected", "applied"],
  production: [],
  rejected: ["applied"],
};

/** Advance the application state; illegal jumps throw (e.g. sandbox before applied). */
export function transitionBingApplication(
  record: BingApplicationRecord,
  to: BingApplicationState,
  note?: string,
): BingApplicationRecord {
  if (to === record.state) return record;
  if (!TRANSITIONS[record.state].includes(to)) {
    throw new BingApplicationError(
      `Cannot move Bing trusted-partner application from "${record.state}" to "${to}". Follow the flow: application → sandbox → production.`,
    );
  }
  const now = new Date();
  const next: BingApplicationRecord = {
    ...record,
    state: to,
    appliedAt: to === "applied" && !record.appliedAt ? now : record.appliedAt,
    sandboxAt: to === "sandbox" && !record.sandboxAt ? now : record.sandboxAt,
    productionAt: to === "production" && !record.productionAt ? now : record.productionAt,
    notes: note ? [...record.notes, note] : record.notes,
    updatedAt: now,
  };
  return next;
}

export function newBingApplication(workspaceId: string): BingApplicationRecord {
  return {
    workspaceId,
    state: "not_started",
    appliedAt: null,
    sandboxAt: null,
    productionAt: null,
    notes: [],
    updatedAt: new Date(),
  };
}

/** True when bulk sync is allowed through the Bing API. */
export function bingSyncAllowed(record: BingApplicationRecord): boolean {
  return record.state === "production";
}
