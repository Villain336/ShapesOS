// Marketr — CAD + Hardware slice 4: hardware project management domain.
// Pure validation + honest predicates. No prisma, no I/O, browser-safe
// (same discipline as lib/cad/geometry.ts).
//
// Guardrails:
// - Costs cite their quote: a part↔supplier link carries a quote (cost +
//   currency + quoted date + source citation). Cost figures are never
//   invented — a link without a quote carries no cost.
// - Only USD quotes flow into BOM line costs: no FX rate is invented to
//   convert a EUR/GBP quote to USD. Non-USD quotes stay cited on the link
//   and the BOM line's cost stays null (the slice-3 rollup already flags
//   unknown costs as a lower-bound warning).
// - Stock is event-sourced: onHandQty is only ever changed by an adjustment
//   event (who/when/delta/reason). Adjustments are never silent overwrites.
// - Low stock is honest arithmetic: onHand <= reorderPoint.

import { CadError, type CadFormat } from "./types";

export const PART_CATEGORIES = [
  "mechanical",
  "electrical",
  "fastener",
  "pcb",
  "cable",
  "tooling",
  "consumable",
  "other",
] as const;
export type PartCategory = (typeof PART_CATEGORIES)[number];

export const TASK_KINDS = ["task", "issue"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const TASK_STATUSES = ["open", "in_progress", "blocked", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["low", "medium", "high"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_EVENT_KINDS = [
  "comment",
  "created",
  "status_change",
  "version_pin",
] as const;
export type TaskEventKind = (typeof TASK_EVENT_KINDS)[number];

export function isPartCategory(v: unknown): v is PartCategory {
  return typeof v === "string" && (PART_CATEGORIES as readonly string[]).includes(v);
}

export function isTaskKind(v: unknown): v is TaskKind {
  return typeof v === "string" && (TASK_KINDS as readonly string[]).includes(v);
}

export function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === "string" && (TASK_STATUSES as readonly string[]).includes(v);
}

export function isTaskPriority(v: unknown): v is TaskPriority {
  return typeof v === "string" && (TASK_PRIORITIES as readonly string[]).includes(v);
}

// ---------- Part input validation ----------

export interface PartInput {
  name: string;
  sku?: string | null;
  category?: string;
  onHandQty?: number;
  reorderPoint?: number;
  unitOfMeasure?: string;
  storageLocation?: string | null;
}

export interface ValidatedPartInput {
  name: string;
  sku: string | null;
  category: PartCategory;
  onHandQty: number;
  reorderPoint: number;
  unitOfMeasure: string;
  storageLocation: string | null;
}

function finiteQty(v: unknown, label: string, allowNegative: boolean): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new CadError("INVALID_PART", `${label} must be a finite number.`);
  if (!allowNegative && n < 0)
    throw new CadError("INVALID_PART", `${label} must be non-negative.`);
  return n;
}

export function validatePartInput(input: PartInput): ValidatedPartInput {
  const name = String(input.name ?? "").trim();
  if (!name) throw new CadError("INVALID_PART", "A part name is required.");
  const sku = input.sku == null ? null : String(input.sku).trim() || null;
  const category = input.category == null || input.category === "" ? "other" : String(input.category).trim();
  if (!isPartCategory(category)) {
    throw new CadError("INVALID_PART", `Unknown part category "${category}".`);
  }
  const onHandQty = input.onHandQty == null ? 0 : finiteQty(input.onHandQty, "On-hand quantity", true);
  const reorderPoint = input.reorderPoint == null ? 0 : finiteQty(input.reorderPoint, "Reorder point", false);
  const unitOfMeasure = input.unitOfMeasure == null || String(input.unitOfMeasure).trim() === ""
    ? "pcs"
    : String(input.unitOfMeasure).trim();
  const storageLocation = input.storageLocation == null ? null : String(input.storageLocation).trim() || null;
  return { name, sku, category, onHandQty, reorderPoint, unitOfMeasure, storageLocation };
}

// ---------- Stock adjustments (auditable events) ----------

export interface StockAdjustmentInput {
  delta: number;
  reason: string;
  // Below-zero stock is a consequential action: it fails closed unless the
  // caller passes an explicit confirmation.
  confirmBelowZero?: boolean;
}

export interface ComputedAdjustment {
  delta: number;
  quantityAfter: number;
  reason: string;
}

export function computeStockAdjustment(
  currentOnHand: number,
  input: StockAdjustmentInput,
): ComputedAdjustment {
  const delta = Number(input.delta);
  if (!Number.isFinite(delta) || delta === 0) {
    throw new CadError("INVALID_ADJUSTMENT", "The adjustment delta must be a non-zero finite number.");
  }
  const reason = String(input.reason ?? "").trim();
  if (!reason) {
    throw new CadError("INVALID_ADJUSTMENT", "A reason is required for every stock adjustment — adjustments are auditable events.");
  }
  const quantityAfter = currentOnHand + delta;
  if (quantityAfter < 0 && !input.confirmBelowZero) {
    throw new CadError(
      "NEGATIVE_STOCK_CONFIRMATION_REQUIRED",
      `This adjustment would take on-hand stock to ${quantityAfter} (below zero). Re-submit with explicit confirmation that negative stock is intended.`,
    );
  }
  return { delta, quantityAfter, reason };
}

/** Low stock is honest arithmetic: on-hand at or below the reorder point. */
export function isLowStock(onHandQty: number, reorderPoint: number): boolean {
  return onHandQty <= reorderPoint;
}

// ---------- Supplier input validation ----------

export interface SupplierInput {
  name: string;
  contact?: string | null;
  leadTime?: string | null;
  notes?: string | null;
}

export interface ValidatedSupplierInput {
  name: string;
  contact: string | null;
  leadTime: string | null;
  notes: string | null;
}

export function validateSupplierInput(input: SupplierInput): ValidatedSupplierInput {
  const name = String(input.name ?? "").trim();
  if (!name) throw new CadError("INVALID_SUPPLIER", "A supplier name is required.");
  return {
    name,
    contact: input.contact == null ? null : String(input.contact).trim() || null,
    leadTime: input.leadTime == null ? null : String(input.leadTime).trim() || null,
    notes: input.notes == null ? null : String(input.notes).trim() || null,
  };
}

// ---------- Part↔supplier link + quoted cost ----------

export interface PartSupplierLinkInput {
  quotedUnitCost?: number | null;
  currency?: string;
  quotedDate?: string | Date | null;
  quoteSource?: string | null;
  preferred?: boolean;
}

export interface ValidatedPartSupplierLinkInput {
  quotedUnitCost: number | null;
  currency: string;
  quotedDate: Date | null;
  quoteSource: string | null;
  preferred: boolean;
}

export function validatePartSupplierLinkInput(input: PartSupplierLinkInput): ValidatedPartSupplierLinkInput {
  let quotedUnitCost: number | null = null;
  if (input.quotedUnitCost != null) {
    const c = Number(input.quotedUnitCost);
    if (!Number.isFinite(c) || c < 0) {
      throw new CadError("INVALID_QUOTE", "The quoted unit cost must be non-negative or null.");
    }
    quotedUnitCost = c;
  }
  const currency = input.currency == null || String(input.currency).trim() === ""
    ? "USD"
    : String(input.currency).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new CadError("INVALID_QUOTE", "Currency must be a 3-letter ISO code.");
  }
  let quotedDate: Date | null = null;
  if (input.quotedDate != null && String(input.quotedDate).trim() !== "") {
    const d = input.quotedDate instanceof Date ? input.quotedDate : new Date(String(input.quotedDate));
    if (Number.isNaN(d.getTime())) throw new CadError("INVALID_QUOTE", "The quoted date is not a valid date.");
    quotedDate = d;
  }
  const quoteSource = input.quoteSource == null ? null : String(input.quoteSource).trim() || null;
  // A quoted cost without a source is unactionable: costs must cite where
  // they came from, so they are never invented figures.
  if (quotedUnitCost != null && !quoteSource) {
    throw new CadError("INVALID_QUOTE", "A quoted unit cost requires its source (who/what gave this price, when).");
  }
  return { quotedUnitCost, currency, quotedDate, quoteSource, preferred: Boolean(input.preferred) };
}

/**
 * The supplier-quoted cost usable for BOM costing. Returns null unless the
 * quote has a cost AND is in USD — no FX rate is ever invented to convert a
 * foreign-currency quote, so non-USD quotes stay cited on the link only.
 */
export function preferredQuoteCostUsd(link: {
  preferred: boolean;
  quotedUnitCost: number | null;
  currency: string;
}): { costUsd: number; currency: string } | null {
  if (!link.preferred) return null;
  if (link.quotedUnitCost == null) return null;
  if (String(link.currency).toUpperCase() !== "USD") return null;
  return { costUsd: link.quotedUnitCost, currency: link.currency };
}

/** Human-readable citation for a quoted cost, e.g. for BOM line sources. */
export function quoteCitation(link: {
  supplierName: string;
  quotedUnitCost: number | null;
  currency: string;
  quotedDate: Date | null;
  quoteSource: string | null;
}): string {
  const date = link.quotedDate ? ` ${link.quotedDate.toISOString().slice(0, 10)}` : "";
  const source = link.quoteSource ? ` — ${link.quoteSource}` : "";
  return `supplier_quote:${link.supplierName}${date}${source}`;
}

// ---------- Task / issue validation ----------

export interface TaskInput {
  kind?: string;
  title: string;
  description?: string | null;
  modelVersionId?: string | null;
  status?: string;
  priority?: string;
  assignee?: string | null;
  dueDate?: string | Date | null;
}

export interface ValidatedTaskInput {
  kind: TaskKind;
  title: string;
  description: string | null;
  modelVersionId: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: string | null;
  dueDate: Date | null;
}

export function validateTaskInput(input: TaskInput): ValidatedTaskInput {
  const title = String(input.title ?? "").trim();
  if (!title) throw new CadError("INVALID_TASK", "A task title is required.");
  const kind = input.kind == null || input.kind === "" ? "task" : String(input.kind).trim();
  if (!isTaskKind(kind)) throw new CadError("INVALID_TASK", `Unknown task kind "${kind}".`);
  const status = input.status == null || input.status === "" ? "open" : String(input.status).trim();
  if (!isTaskStatus(status)) throw new CadError("INVALID_TASK", `Unknown task status "${status}".`);
  const priority = input.priority == null || input.priority === "" ? "medium" : String(input.priority).trim();
  if (!isTaskPriority(priority)) throw new CadError("INVALID_TASK", `Unknown task priority "${priority}".`);
  let dueDate: Date | null = null;
  if (input.dueDate != null && String(input.dueDate).trim() !== "") {
    const d = input.dueDate instanceof Date ? input.dueDate : new Date(String(input.dueDate));
    if (Number.isNaN(d.getTime())) throw new CadError("INVALID_TASK", "The due date is not a valid date.");
    dueDate = d;
  }
  return {
    kind,
    title,
    description: input.description == null ? null : String(input.description).trim() || null,
    modelVersionId: input.modelVersionId == null ? null : String(input.modelVersionId).trim() || null,
    status,
    priority,
    assignee: input.assignee == null ? null : String(input.assignee).trim() || null,
    dueDate,
  };
}

export interface ValidatedTaskPatch {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignee?: string | null;
  dueDate?: Date | null;
  kind?: TaskKind;
}

export function validateTaskPatch(input: Partial<TaskInput>): ValidatedTaskPatch {
  const patch: ValidatedTaskPatch = {};
  if (input.title !== undefined) {
    const title = String(input.title ?? "").trim();
    if (!title) throw new CadError("INVALID_TASK", "A task title is required.");
    patch.title = title;
  }
  if (input.description !== undefined) {
    patch.description = input.description == null ? null : String(input.description).trim() || null;
  }
  if (input.status !== undefined) {
    if (!isTaskStatus(String(input.status))) throw new CadError("INVALID_TASK", `Unknown task status "${input.status}".`);
    patch.status = input.status as TaskStatus;
  }
  if (input.priority !== undefined) {
    if (!isTaskPriority(String(input.priority))) throw new CadError("INVALID_TASK", `Unknown task priority "${input.priority}".`);
    patch.priority = input.priority as TaskPriority;
  }
  if (input.kind !== undefined) {
    if (!isTaskKind(String(input.kind))) throw new CadError("INVALID_TASK", `Unknown task kind "${input.kind}".`);
    patch.kind = input.kind as TaskKind;
  }
  if (input.assignee !== undefined) {
    patch.assignee = input.assignee == null ? null : String(input.assignee).trim() || null;
  }
  if (input.dueDate !== undefined) {
    if (input.dueDate == null || String(input.dueDate).trim() === "") {
      patch.dueDate = null;
    } else {
      const d = input.dueDate instanceof Date ? input.dueDate : new Date(String(input.dueDate));
      if (Number.isNaN(d.getTime())) throw new CadError("INVALID_TASK", "The due date is not a valid date.");
      patch.dueDate = d;
    }
  }
  return patch;
}

export function validateTaskCommentBody(body: unknown): string {
  const text = String(body ?? "").trim();
  if (!text) throw new CadError("INVALID_COMMENT", "A comment body is required.");
  if (text.length > 8000) throw new CadError("INVALID_COMMENT", "Comment is too long (max 8000 characters).");
  return text;
}

// ---------- Dashboard rollup (pure assembly from real rows) ----------

export interface DashboardBomCost {
  modelId: string;
  modelName: string;
  bomVersionId: string | null;
  bomNumber: number | null;
  knownCostUsd: number | null;
  linesMissingCost: number;
  basis: string;
}

export interface DashboardLatestVersion {
  modelId: string;
  modelName: string;
  versionId: string;
  versionNumber: number;
  format: CadFormat;
  uploadedAt: Date;
}

export function isTaskOpen(status: string): boolean {
  return status === "open" || status === "in_progress" || status === "blocked";
}
