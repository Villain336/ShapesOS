// Marketr — Wave 2 WFH mode slice 6 (SPEC-WFH-MODE.md): home-office expense pack.
//
// Pre-wired categories (utilities %, internet, equipment, supplies) with
// allocation rules (flat % of the bill or square-footage method), and a
// deduction computation (amount × allocation). This is NOT a full expense
// product: it is a category pack + allocation engine with a documented post
// hook (`toLedgerEntry`) that a finance ledger / Phase 14 Composio+Univer
// layer can consume later.
//
// This module never gives tax advice. It computes arithmetic on the user's
// own allocation settings; the numbers are a starting point for their
// accountant, not a filing.

export type AllocationMethod = "flat_percent" | "square_footage";

export const ALLOCATION_METHODS = ["flat_percent", "square_footage"] as const;

export interface CategoryPreset {
  key: string;
  name: string;
  description: string;
  defaultAllocationPct: number; // business-use % of the bill
  defaultMethod: AllocationMethod;
}

// Pre-wired home-office categories (SPEC-WFH-MODE.md §4).
export const EXPENSE_CATEGORY_PRESETS: CategoryPreset[] = [
  {
    key: "utilities",
    name: "Utilities",
    description: "Electricity, gas, water — allocated by business-use %.",
    defaultAllocationPct: 15,
    defaultMethod: "flat_percent",
  },
  {
    key: "internet",
    name: "Internet",
    description: "Home internet — allocated by business-use %.",
    defaultAllocationPct: 50,
    defaultMethod: "flat_percent",
  },
  {
    key: "phone",
    name: "Phone",
    description: "Mobile plan used for work — allocated by business-use %.",
    defaultAllocationPct: 40,
    defaultMethod: "flat_percent",
  },
  {
    key: "equipment",
    name: "Equipment",
    description: "Desk, chair, monitor, peripherals — usually 100% business.",
    defaultAllocationPct: 100,
    defaultMethod: "flat_percent",
  },
  {
    key: "supplies",
    name: "Office supplies",
    description: "Paper, ink, cables, small consumables — usually 100% business.",
    defaultAllocationPct: 100,
    defaultMethod: "flat_percent",
  },
  {
    key: "home-office-space",
    name: "Home office space",
    description: "Portion of rent/mortgage — square-footage method.",
    defaultAllocationPct: 10,
    defaultMethod: "square_footage",
  },
];

export class WfhExpenseError extends Error {
  code: string;
  details: string[];
  constructor(code: string, message: string, details: string[] = []) {
    super(message);
    this.name = "WfhExpenseError";
    this.code = code;
    this.details = details;
  }
}

export interface AllocationRule {
  method: AllocationMethod;
  /** For flat_percent: 0–100. For square_footage: office sqft / total sqft × 100. */
  percent: number;
  officeSqft?: number | null;
  totalSqft?: number | null;
}

export function validateAllocationRule(rule: Partial<AllocationRule>): {
  ok: boolean;
  errors: string[];
  normalized?: AllocationRule;
} {
  const errors: string[] = [];
  const method = (rule.method ?? "flat_percent") as AllocationMethod;
  if (!(ALLOCATION_METHODS as readonly string[]).includes(method)) {
    errors.push(`method: must be one of ${ALLOCATION_METHODS.join(", ")}`);
  }

  let percent = Number(rule.percent);
  if (method === "square_footage") {
    const office = Number(rule.officeSqft);
    const total = Number(rule.totalSqft);
    if (!isFinite(office) || office <= 0) errors.push("officeSqft: required, positive");
    if (!isFinite(total) || total <= 0) errors.push("totalSqft: required, positive");
    if (isFinite(office) && isFinite(total) && office > total) {
      errors.push("officeSqft: cannot exceed totalSqft");
    }
    if (errors.length === 0) percent = (office / total) * 100;
  } else {
    if (!isFinite(percent) || percent < 0 || percent > 100) {
      errors.push("percent: must be between 0 and 100");
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    normalized: {
      method,
      percent: Math.round(percent * 100) / 100,
      officeSqft: rule.officeSqft != null ? Number(rule.officeSqft) : null,
      totalSqft: rule.totalSqft != null ? Number(rule.totalSqft) : null,
    },
  };
}

export interface ExpenseDraft {
  categoryKey: string;
  amountCents: number;
  currency?: string;
  occurredOn: Date;
  allocation: AllocationRule;
  note?: string | null;
  receiptUrl?: string | null;
}

export interface ValidatedExpense {
  categoryKey: string;
  amountCents: number;
  currency: string;
  occurredOn: Date;
  allocationMethod: AllocationMethod;
  allocationPct: number;
  deductibleCents: number;
  note: string | null;
  receiptUrl: string | null;
}

export function validateExpense(draft: Partial<ExpenseDraft>): {
  ok: boolean;
  errors: string[];
  normalized?: ValidatedExpense;
} {
  const errors: string[] = [];

  const preset = EXPENSE_CATEGORY_PRESETS.find((p) => p.key === draft.categoryKey);
  if (!preset) errors.push(`categoryKey: must be one of ${EXPENSE_CATEGORY_PRESETS.map((p) => p.key).join(", ")}`);

  const amountCents = Math.round(Number(draft.amountCents));
  if (!isFinite(amountCents) || amountCents <= 0) {
    errors.push("amountCents: must be a positive whole number of cents");
  }

  const currency = (draft.currency ?? "USD").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) errors.push("currency: must be a 3-letter ISO code");

  let occurredOn: Date | null = null;
  if (draft.occurredOn instanceof Date && !isNaN(draft.occurredOn.getTime())) {
    occurredOn = draft.occurredOn;
  } else if (typeof draft.occurredOn === "string") {
    const d = new Date(draft.occurredOn);
    if (!isNaN(d.getTime())) occurredOn = d;
  }
  if (!occurredOn) errors.push("occurredOn: required");
  else if (occurredOn.getTime() > Date.now() + 24 * 3600 * 1000) {
    errors.push("occurredOn: cannot be in the future");
  }

  const alloc = validateAllocationRule(draft.allocation ?? {});
  if (!alloc.ok) errors.push(...alloc.errors.map((e) => `allocation.${e}`));

  const note = draft.note != null ? String(draft.note).trim().slice(0, 500) || null : null;

  let receiptUrl: string | null = null;
  if (draft.receiptUrl != null && String(draft.receiptUrl).trim() !== "") {
    const raw = String(draft.receiptUrl).trim();
    if (!/^https?:\/\//i.test(raw)) errors.push("receiptUrl: must be an http(s) URL");
    else if (raw.length > 2048) errors.push("receiptUrl: max 2048 characters");
    else receiptUrl = raw;
  }

  if (errors.length > 0 || !alloc.normalized || !occurredOn) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    errors: [],
    normalized: {
      categoryKey: preset!.key,
      amountCents,
      currency,
      occurredOn,
      allocationMethod: alloc.normalized.method,
      allocationPct: alloc.normalized.percent,
      deductibleCents: Math.round((amountCents * alloc.normalized.percent) / 100),
      note,
      receiptUrl,
    },
  };
}

/** Recompute the deductible portion when a category's allocation changes. */
export function recomputeDeductible(amountCents: number, allocationPct: number): number {
  return Math.round((amountCents * allocationPct) / 100);
}

// ── Finance-ledger post hook ──────────────────────────────────────────────
// A future ledger (or the Phase 14 Composio+Univer layer) consumes WFH
// expenses through this shape. Call toLedgerEntry on a stored expense row and
// POST the result to the ledger's ingest endpoint. This module never writes
// to a ledger itself — the hook is the contract, not the integration.

export interface LedgerEntryInput {
  id: string;
  categoryKey: string;
  categoryName: string;
  amountCents: number;
  currency: string;
  occurredOn: Date;
  deductibleCents: number;
  allocationPct: number;
  allocationMethod: AllocationMethod;
  note: string | null;
  receiptUrl: string | null;
  workspaceId: string;
  userId: string;
}

export interface LedgerEntry {
  externalId: string;
  source: "wfh-expense-pack";
  occurredOn: string;
  amountCents: number;
  currency: string;
  category: string;
  memo: string;
  metadata: Record<string, string | number | null>;
}

export function toLedgerEntry(e: LedgerEntryInput): LedgerEntry {
  return {
    externalId: `wfh-expense:${e.id}`,
    source: "wfh-expense-pack",
    occurredOn: e.occurredOn.toISOString().slice(0, 10),
    amountCents: e.amountCents,
    currency: e.currency,
    category: `home-office:${e.categoryKey}`,
    memo: e.note ?? e.categoryName,
    metadata: {
      workspaceId: e.workspaceId,
      userId: e.userId,
      deductibleCents: e.deductibleCents,
      allocationPct: e.allocationPct,
      allocationMethod: e.allocationMethod,
      receiptUrl: e.receiptUrl,
    },
  };
}
