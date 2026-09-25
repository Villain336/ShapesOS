// Marketr — Phase 5 A1: receipt reconciliation.
//
// Ledger vs platform actuals/invoices. Variance is SURFACED, never silent.
// Mirrors app/api/mail/reconcile's contract (ledger estimate vs provider
// actuals + manual invoices), adapted to media buys.
//
// MONEY POSTURE: this module only READS and COMPARES. It never authorizes
// spend. Ledger writes require approvalRef (enforced in lib/media/store.ts);
// a write without one throws MissingApprovalRefError.
// Fake/test mode default: FakePlatformSpendFeed returns deterministic
// invoice actuals. No live platform invoices in v1.

import type { MediaStore, MediaSpendEntry, MediaReceipt } from "./store";

// ---------------------------------------------------------------------------
// Platform spend feed (fake default)
// ---------------------------------------------------------------------------

export interface PlatformSpendLine {
  platform: string;
  /** Provider's invoice/campaign reference. */
  invoiceRef: string;
  amountCents: number;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string; // YYYY-MM-DD
}

export interface PlatformSpendProvider {
  readonly name: string;
  getActualSpend(opts: { workspaceId: string; buyId: string }): Promise<PlatformSpendLine[]>;
}

/**
 * Fake platform-spend feed: deterministic actuals per buy. In tests the
 * battery seeds the ledger to match, so reconciliation lands at variance 0.
 * Seeds can include an intentional drift to exercise the variance flags.
 */
export class FakePlatformSpendFeed implements PlatformSpendProvider {
  readonly name = "fake" as const;
  constructor(private lines: PlatformSpendLine[] = []) {}

  seed(lines: PlatformSpendLine[]): void {
    this.lines = lines;
  }

  async getActualSpend(opts: { workspaceId: string; buyId: string }): Promise<PlatformSpendLine[]> {
    void opts;
    return this.lines.map((l) => ({ ...l }));
  }
}

export class RealPlatformSpendFeed implements PlatformSpendProvider {
  readonly name = "live" as const;
  async getActualSpend(_opts: { workspaceId: string; buyId: string }): Promise<PlatformSpendLine[]> {
    // Live platform invoice pulls (Blip/Blindspot/Spotify/Acast/AudioGo)
    // land here once operator connections exist. No live path in v1.
    throw new Error("Live platform spend feed is not configured in v1 — no operator connections yet");
  }
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export interface ReconcileLineItem {
  label: string;
  ledgerCents: number;
  actualCents: number;
  varianceCents: number;
  source: "ledger" | "platform" | "receipt";
}

export interface ReconcileFlag {
  code: string;
  severity: "warn" | "info";
  message: string;
}

export interface ReconciliationReport {
  buyId: string;
  ledger: { entries: number; spendCents: number; encumberedCents: number };
  actual: { lines: number; totalCents: number };
  receipts: { count: number; reconciled: number; unreconciled: number };
  varianceCents: number;
  lineItems: ReconcileLineItem[];
  flags: ReconcileFlag[];
  generatedAt: string;
}

/** Rounding tolerance: within $0.05 is "within rounding". */
export const RECONCILE_TOLERANCE_CENTS = 5;

export function ledgerSpendCents(entries: MediaSpendEntry[]): number {
  // "spend" entries are realized; "encumbrance" is reserved-not-spent and
  // reported separately. "release"/"adjust" offset encumbrance.
  return entries.filter((e) => e.kind === "spend").reduce((n, e) => n + e.amountCents, 0);
}

export function ledgerEncumberedCents(entries: MediaSpendEntry[]): number {
  const enc = entries.filter((e) => e.kind === "encumbrance").reduce((n, e) => n + e.amountCents, 0);
  const rel = entries
    .filter((e) => e.kind === "release" || e.kind === "adjust")
    .reduce((n, e) => n + e.amountCents, 0);
  return enc - rel;
}

export async function reconcileBuy(
  store: MediaStore,
  feed: PlatformSpendProvider,
  workspaceId: string,
  buyId: string,
): Promise<ReconciliationReport> {
  const entries = await store.listSpendEntries(workspaceId, buyId);
  const receipts = await store.listReceipts(workspaceId, buyId);
  const actuals = await feed.getActualSpend({ workspaceId, buyId });

  const spendCents = ledgerSpendCents(entries);
  const encumberedCents = ledgerEncumberedCents(entries);
  const actualCents = actuals.reduce((n, l) => n + l.amountCents, 0);

  const lineItems: ReconcileLineItem[] = [
    {
      label: "Ledger realized spend vs platform actuals",
      ledgerCents: spendCents,
      actualCents,
      varianceCents: actualCents - spendCents,
      source: "ledger",
    },
  ];
  for (const a of actuals) {
    lineItems.push({
      label: `Platform invoice ${a.invoiceRef} (${a.platform}, ${a.periodStart}→${a.periodEnd})`,
      ledgerCents: 0,
      actualCents: a.amountCents,
      varianceCents: a.amountCents,
      source: "platform",
    });
  }
  for (const r of receipts) {
    lineItems.push({
      label: `Receipt ${r.platformInvoiceRef}`,
      ledgerCents: 0,
      actualCents: r.amountCents,
      varianceCents: r.reconciled ? (r.varianceCents ?? 0) : r.amountCents,
      source: "receipt",
    });
  }

  const varianceCents = actualCents - spendCents;
  const flags: ReconcileFlag[] = [];

  if (Math.abs(varianceCents) > RECONCILE_TOLERANCE_CENTS) {
    flags.push({
      code: "VARIANCE",
      severity: "warn",
      message: `Ledger vs platform variance $${(varianceCents / 100).toFixed(2)} — investigate before closing the buy.`,
    });
  } else if (entries.length > 0 || actuals.length > 0) {
    flags.push({
      code: "WITHIN_ROUNDING",
      severity: "info",
      message: "Ledger and platform actuals agree within rounding ($0.05).",
    });
  }
  if (actuals.length > 0 && receipts.length === 0) {
    flags.push({
      code: "NO_RECEIPT",
      severity: "warn",
      message: "Platform actuals exist but no receipt was captured — upload the invoice to close the loop.",
    });
  }
  const unreconciled = receipts.filter((r) => !r.reconciled).length;
  if (unreconciled > 0) {
    flags.push({
      code: "UNRECONCILED_RECEIPTS",
      severity: "info",
      message: `${unreconciled} receipt(s) captured but not yet reconciled.`,
    });
  }
  if (entries.length === 0 && actuals.length === 0) {
    flags.push({
      code: "NO_DATA",
      severity: "info",
      message: "No ledger entries or platform actuals for this buy yet.",
    });
  }

  // Mark receipts reconciled when both sides exist: a receipt is reconciled
  // when its invoice matches the ledger's realized spend within tolerance.
  for (const r of receipts) {
    if (!r.reconciled && entries.length > 0) {
      const v = r.amountCents - spendCents;
      await store.markReceiptReconciled(r.id, v);
      r.reconciled = true;
      r.varianceCents = v;
    }
  }

  return {
    buyId,
    ledger: { entries: entries.length, spendCents, encumberedCents },
    actual: { lines: actuals.length, totalCents: actualCents },
    receipts: {
      count: receipts.length,
      reconciled: receipts.filter((r) => r.reconciled).length,
      unreconciled: receipts.filter((r) => !r.reconciled).length,
    },
    varianceCents,
    lineItems,
    flags,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Ledger helpers (approvalRef is mandatory — enforced by the store)
// ---------------------------------------------------------------------------

export interface RecordSpendInput {
  workspaceId: string;
  buyId: string;
  kind: MediaSpendEntry["kind"];
  amountCents: number;
  approvalRef: string;
  note?: string;
}

export async function recordSpend(store: MediaStore, input: RecordSpendInput): Promise<MediaSpendEntry> {
  if (!Number.isInteger(input.amountCents) || input.amountCents < 0) {
    throw new Error("amountCents must be a non-negative integer");
  }
  return store.recordSpendEntry({
    workspaceId: input.workspaceId,
    buyId: input.buyId,
    kind: input.kind,
    amountCents: input.amountCents,
    approvalRef: input.approvalRef,
    note: input.note ?? null,
  });
}

export async function recordReceipt(
  store: MediaStore,
  input: {
    workspaceId: string;
    buyId: string;
    platformInvoiceRef: string;
    amountCents: number;
    approvalRef: string;
  },
): Promise<MediaReceipt> {
  if (!Number.isInteger(input.amountCents) || input.amountCents < 0) {
    throw new Error("amountCents must be a non-negative integer");
  }
  return store.recordReceipt({
    workspaceId: input.workspaceId,
    buyId: input.buyId,
    platformInvoiceRef: input.platformInvoiceRef,
    amountCents: input.amountCents,
    approvalRef: input.approvalRef,
  });
}
