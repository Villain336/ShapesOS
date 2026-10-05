// Marketr — CAD + Hardware slice 3: prototype pipeline domain logic.
// Spec: BUSINESS-OS-FEATURE-SPECS.md §2. Reference customer: the autonomous
// drone platform build (airframe parts ordered as 3D-print / PCB / CNC
// prototypes, BOMs tied to costs per revision).
//
// v1 contract (read before touching this file):
//   1. NO LIVE VENDOR APIS. Quote requests are draft-for-approval records.
//      Confirming a request writes the vendor-ready export package (model
//      file + manifest with checksum + process parameters + contact details)
//      to the workspace file store. "Sending" records the tenant's own
//      transmission as an auditable event (who sent, when, to whom, via
//      which connected account) — it NEVER places an order or transmits
//      anything externally. v1 does not place orders.
//   2. BOMs pin to model versions. Every line item carries a source
//      ("manual" | "derived:<method>"). Phase 4b adds ONE derived method,
//      "mesh_bodies" (lib/cad/bom-derive.ts): bodies, quantities, volume and
//      material mass measured from the version's real mesh. Fastener counts
//      and bought-in parts are not in a mesh, so they stay manual lines.
//      Derived lines are written only by the derive path, never by hand.
//   3. Cost estimates are ESTIMATES: BOM total × quantity + rate-card
//      process cost, every number labeled, the rate card cited by id/name,
//      warnings recorded for anything uncomputable. Vendor quotes are never
//      fabricated — nothing here is a quote.
//
// Hard guardrails inherited from slices 1–2: tenant-scoped everywhere
// (workspaceId on every row and query), STEP never pretends to have mesh
// geometry (a STEP version has no volume estimate, so volume-based process
// costs report "unavailable" instead of a guess).

import { CadError } from "./types";

/** Prototype fabrication processes supported by the export pipeline. */
export const EXPORT_PROCESSES = [
  { value: "3d_print", label: "3D print" },
  { value: "pcb", label: "PCB" },
  { value: "cnc", label: "CNC" },
] as const;

export type ExportProcess = (typeof EXPORT_PROCESSES)[number]["value"];

export function isExportProcess(v: string): v is ExportProcess {
  return (EXPORT_PROCESSES as readonly { value: string }[]).some(
    (p) => p.value === v,
  );
}

export function exportProcessLabel(process: ExportProcess): string {
  return (
    EXPORT_PROCESSES.find((p) => p.value === process)?.label ?? process
  );
}

/**
 * Per-process option schemas. Options are tenant-entered strings/numbers;
 * the OS does not validate them against any vendor catalog (there is none
 * in v1 — see the contract above).
 */
export const PROCESS_OPTION_FIELDS: Record<
  ExportProcess,
  { key: string; label: string; placeholder: string }[]
> = {
  "3d_print": [
    { key: "material", label: "Material", placeholder: "e.g. PETG, ASA, Nylon" },
    { key: "infillPercent", label: "Infill %", placeholder: "e.g. 20" },
    { key: "layerHeightMm", label: "Layer height (mm)", placeholder: "e.g. 0.2" },
  ],
  pcb: [
    { key: "layers", label: "Layers", placeholder: "e.g. 4" },
    { key: "thicknessMm", label: "Board thickness (mm)", placeholder: "e.g. 1.6" },
    { key: "finish", label: "Surface finish", placeholder: "e.g. ENIG, HASL" },
    { key: "solderMask", label: "Solder mask color", placeholder: "e.g. green" },
  ],
  cnc: [
    { key: "material", label: "Material", placeholder: "e.g. 6061 aluminum" },
    { key: "toleranceMm", label: "Tolerance (mm)", placeholder: "e.g. ±0.1" },
    { key: "finish", label: "Finish", placeholder: "e.g. bead blast, anodized" },
  ],
};

export type ProcessOptions = Record<string, string>;

function validateProcessOptions(process: ExportProcess, options: unknown): ProcessOptions {
  if (options == null) return {};
  if (typeof options !== "object" || Array.isArray(options)) {
    throw new CadError("INVALID_PROCESS_OPTIONS", "Process options must be an object of string values.");
  }
  const allowed = new Set(PROCESS_OPTION_FIELDS[process].map((f) => f.key));
  const out: ProcessOptions = {};
  for (const [k, v] of Object.entries(options as Record<string, unknown>)) {
    if (!allowed.has(k)) {
      throw new CadError("INVALID_PROCESS_OPTIONS", `Unknown option "${k}" for process ${process}.`);
    }
    out[k] = String(v ?? "").trim();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Contact / shipping details
// ---------------------------------------------------------------------------

/**
 * Contact + shipping details ride on the quote request itself. v1 has no
 * tenant-profile store, so the tenant enters them on the export form; the
 * route pre-fills name/email from the workspace + session where present.
 * Nothing is inferred beyond that.
 */
export interface ContactDetails {
  name: string;
  email: string;
  addressLines: string[];
}

export function validateContact(input: unknown): ContactDetails {
  const o = (input ?? {}) as Record<string, unknown>;
  const name = String(o.name ?? "").trim();
  const email = String(o.email ?? "").trim();
  const rawLines = Array.isArray(o.addressLines) ? o.addressLines : [];
  const addressLines = rawLines.map((l) => String(l ?? "").trim()).filter(Boolean);
  if (!name) throw new CadError("INVALID_CONTACT", "A contact name is required on the quote request.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new CadError("INVALID_CONTACT", "A valid contact email is required on the quote request.");
  }
  if (addressLines.length === 0) {
    throw new CadError("INVALID_CONTACT", "At least one shipping address line is required on the quote request.");
  }
  return { name, email, addressLines };
}

// ---------------------------------------------------------------------------
// BOM
// ---------------------------------------------------------------------------

/** BOM line-item source. */
export type BomLineSource = "manual" | `derived:${string}`;

/**
 * Derived BOM methods that exist. "mesh_bodies" measures the bodies in a
 * version's mesh (lib/cad/bom-derive.ts) and needs a tenant-picked material
 * for mass. Anything else (e.g. "fastener_count") is rejected with
 * DERIVED_METHOD_UNSUPPORTED — a mesh doesn't know it. Even a supported
 * method can't be typed in by hand (DERIVED_LINE_NOT_MANUAL): derived lines
 * come only from a derivation, so their measurements are real.
 */
export const DERIVED_METHODS: readonly string[] = ["mesh_bodies"];

export function isBomLineSource(v: string): v is BomLineSource {
  if (v === "manual") return true;
  return v.startsWith("derived:");
}

export interface BomLineInput {
  partName: string;
  qty: number;
  unitName?: string;
  materialSpec?: string;
  supplier?: string;
  /** USD per unit. Null = unknown: the line contributes $0 and is flagged. */
  unitCostUsd?: number | null;
  source?: string;
}

export function validateBomLineInput(input: BomLineInput): Required<
  Pick<BomLineInput, "partName" | "qty" | "unitName" | "source">
> &
  Pick<BomLineInput, "materialSpec" | "supplier" | "unitCostUsd"> {
  const partName = String(input.partName ?? "").trim();
  if (!partName) throw new CadError("INVALID_BOM_LINE", "A part name is required.");
  const qty = Number(input.qty);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new CadError("INVALID_BOM_LINE", "Quantity must be a positive number.");
  }
  const unitName = String(input.unitName ?? "pcs").trim() || "pcs";
  const source = String(input.source ?? "manual").trim();
  if (!isBomLineSource(source)) {
    throw new CadError("INVALID_BOM_LINE", `Source must be "manual" or "derived:<method>"; got "${source}".`);
  }
  if (source.startsWith("derived:")) {
    const method = source.slice("derived:".length);
    if (!(DERIVED_METHODS as readonly string[]).includes(method)) {
      throw new CadError(
        "DERIVED_METHOD_UNSUPPORTED",
        `Derived BOM method "${method}" is not implemented — a mesh can't tell us that. Add the line manually.`,
      );
    }
    throw new CadError(
      "DERIVED_LINE_NOT_MANUAL",
      `"${source}" lines are created by deriving a BOM from the model's geometry, not entered by hand. Add the line as manual.`,
    );
  }
  let unitCostUsd: number | null = null;
  if (input.unitCostUsd != null) {
    const c = Number(input.unitCostUsd);
    if (!Number.isFinite(c) || c < 0) {
      throw new CadError("INVALID_BOM_LINE", "Unit cost must be a non-negative number or omitted.");
    }
    unitCostUsd = c;
  }
  return {
    partName,
    qty,
    unitName,
    source,
    materialSpec: input.materialSpec?.trim() || undefined,
    supplier: input.supplier?.trim() || undefined,
    unitCostUsd,
  };
}

export interface BomRollupLine {
  lineId: string;
  partName: string;
  qty: number;
  unitName: string;
  materialSpec?: string;
  supplier?: string;
  unitCostUsd: number | null;
  /** qty × unitCostUsd; 0 when unitCostUsd is null (flagged in missingCost). */
  lineTotalUsd: number;
  missingCost: boolean;
  source: string;
  /** Per-unit volume (mm³) and mass (g) — derived lines only; null = unknown. */
  volumeMm3: number | null;
  massG: number | null;
  /** qty × massG; null when the mass is unknown. */
  lineMassG: number | null;
}

export interface BomRollup {
  lineCount: number;
  /** Sum of line totals. Lines with unknown unit cost contribute $0. */
  totalUsd: number;
  linesMissingCost: number;
  /** Sum of known line masses (g); null when no line has a mass. */
  totalMassG: number | null;
  linesMissingMass: number;
  lines: BomRollupLine[];
}

export interface BomRollupInputLine {
  id: string;
  partName: string;
  qty: number;
  unitName: string;
  materialSpec?: string | null;
  supplier?: string | null;
  unitCostUsd: number | null;
  source: string;
  volumeMm3?: number | null;
  massG?: number | null;
}

function finiteOrNull(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

export function computeBomRollup(lines: BomRollupInputLine[]): BomRollup {
  const rolled: BomRollupLine[] = lines.map((l) => {
    const unitCostUsd = finiteOrNull(l.unitCostUsd);
    const missingCost = unitCostUsd == null;
    const lineTotalUsd = missingCost ? 0 : round2(l.qty * unitCostUsd);
    const massG = finiteOrNull(l.massG);
    return {
      lineId: l.id,
      partName: l.partName,
      qty: l.qty,
      unitName: l.unitName,
      materialSpec: l.materialSpec ?? undefined,
      supplier: l.supplier ?? undefined,
      unitCostUsd,
      lineTotalUsd,
      missingCost,
      source: l.source,
      volumeMm3: finiteOrNull(l.volumeMm3),
      massG,
      lineMassG: massG == null ? null : round2(l.qty * massG),
    };
  });
  const totalUsd = round2(rolled.reduce((s, l) => s + l.lineTotalUsd, 0));
  const massLines = rolled.filter((l) => l.lineMassG != null);
  return {
    lineCount: rolled.length,
    totalUsd,
    linesMissingCost: rolled.filter((l) => l.missingCost).length,
    totalMassG: massLines.length ? round2(massLines.reduce((s, l) => s + (l.lineMassG as number), 0)) : null,
    linesMissingMass: rolled.length - massLines.length,
    lines: rolled,
  };
}

// ---------------------------------------------------------------------------
// BOM comparison across revisions
// ---------------------------------------------------------------------------

export type BomDiffStatus = "added" | "removed" | "changed" | "unchanged";

export interface BomDiffLine {
  key: string;
  partName: string;
  materialSpec: string | null;
  status: BomDiffStatus;
  qtyFrom: number | null;
  qtyTo: number | null;
  qtyDelta: number;
  /** Per-unit mass on each side (null = unknown). */
  massFromG: number | null;
  massToG: number | null;
  lineTotalFromUsd: number;
  lineTotalToUsd: number;
  lineTotalDeltaUsd: number;
}

export interface BomComparison {
  lines: BomDiffLine[];
  totals: {
    lineCountFrom: number;
    lineCountTo: number;
    totalFromUsd: number;
    totalToUsd: number;
    totalDeltaUsd: number;
    /** Known masses only; null when a side has no mass at all. */
    massFromG: number | null;
    massToG: number | null;
    massDeltaG: number | null;
    added: number;
    removed: number;
    changed: number;
  };
}

function bomKey(l: BomRollupLine): string {
  return `${l.partName.trim().toLowerCase()}|${(l.materialSpec ?? "").trim().toLowerCase()}`;
}

interface BomAgg {
  partName: string;
  materialSpec: string | null;
  qty: number;
  mass: number | null;
  total: number;
}

function aggregateBom(rollup: BomRollup): Map<string, BomAgg> {
  const out = new Map<string, BomAgg>();
  for (const l of rollup.lines) {
    const k = bomKey(l);
    const a = out.get(k);
    if (a) {
      a.qty += l.qty;
      a.total = round2(a.total + l.lineTotalUsd);
      a.mass = a.mass ?? l.massG;
    } else {
      out.set(k, { partName: l.partName, materialSpec: l.materialSpec ?? null, qty: l.qty, mass: l.massG, total: l.lineTotalUsd });
    }
  }
  return out;
}

function sameNumber(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return a === b;
  return Math.abs(a - b) <= Math.max(1e-6, Math.abs(a) * 1e-4);
}

/**
 * Part-level diff between two BOM rollups (e.g. airframe v6 → v7). Lines are
 * matched on part name + material; duplicates within one BOM are summed.
 */
export function compareBomRollups(from: BomRollup, to: BomRollup): BomComparison {
  const a = aggregateBom(from);
  const b = aggregateBom(to);
  const keys = [...new Set([...a.keys(), ...b.keys()])];
  const lines: BomDiffLine[] = keys.map((key) => {
    const x = a.get(key);
    const y = b.get(key);
    const status: BomDiffStatus = !x
      ? "added"
      : !y
        ? "removed"
        : x.qty === y.qty && sameNumber(x.mass, y.mass) && sameNumber(x.total, y.total)
          ? "unchanged"
          : "changed";
    const lineTotalFromUsd = x?.total ?? 0;
    const lineTotalToUsd = y?.total ?? 0;
    const either = (y ?? x)!;
    return {
      key,
      partName: either.partName,
      materialSpec: either.materialSpec,
      status,
      qtyFrom: x?.qty ?? null,
      qtyTo: y?.qty ?? null,
      qtyDelta: (y?.qty ?? 0) - (x?.qty ?? 0),
      massFromG: x?.mass ?? null,
      massToG: y?.mass ?? null,
      lineTotalFromUsd,
      lineTotalToUsd,
      lineTotalDeltaUsd: round2(lineTotalToUsd - lineTotalFromUsd),
    };
  });
  const order: Record<BomDiffStatus, number> = { added: 0, changed: 1, removed: 2, unchanged: 3 };
  lines.sort((p, q) => order[p.status] - order[q.status] || p.partName.localeCompare(q.partName));
  return {
    lines,
    totals: {
      lineCountFrom: from.lineCount,
      lineCountTo: to.lineCount,
      totalFromUsd: from.totalUsd,
      totalToUsd: to.totalUsd,
      totalDeltaUsd: round2(to.totalUsd - from.totalUsd),
      massFromG: from.totalMassG,
      massToG: to.totalMassG,
      massDeltaG:
        from.totalMassG == null || to.totalMassG == null ? null : round2(to.totalMassG - from.totalMassG),
      added: lines.filter((l) => l.status === "added").length,
      removed: lines.filter((l) => l.status === "removed").length,
      changed: lines.filter((l) => l.status === "changed").length,
    },
  };
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

export const BOM_CSV_HEADER = [
  "part",
  "qty",
  "unit",
  "material",
  "supplier",
  "volume_cm3_per_unit",
  "mass_g_per_unit",
  "line_mass_g",
  "unit_cost_usd",
  "line_total_usd",
  "cost_known",
  "source",
] as const;

/**
 * BOM rollup → CSV rows (header, one row per line, blank, total). Every
 * cell goes through lib/csv.ts (RFC 4180 quoting + formula-injection
 * neutralization: part names and suppliers are tenant/collaborator text).
 * Unknown numbers are empty cells, never 0.
 */
export function bomCsvRows(rollup: BomRollup): unknown[][] {
  const rows: unknown[][] = [[...BOM_CSV_HEADER]];
  for (const l of rollup.lines) {
    rows.push([
      l.partName,
      l.qty,
      l.unitName,
      l.materialSpec ?? "",
      l.supplier ?? "",
      l.volumeMm3 == null ? null : round2(l.volumeMm3 / 1000),
      l.massG,
      l.lineMassG,
      l.unitCostUsd,
      l.missingCost ? null : l.lineTotalUsd,
      l.missingCost ? "no" : "yes",
      l.source,
    ]);
  }
  rows.push([]);
  rows.push([
    "TOTAL",
    null,
    null,
    null,
    null,
    null,
    null,
    rollup.totalMassG,
    null,
    rollup.totalUsd,
    rollup.linesMissingCost > 0 ? `lower bound (${rollup.linesMissingCost} line(s) without cost)` : "yes",
    null,
  ]);
  return rows;
}

// ---------------------------------------------------------------------------
// Rate cards + cost estimates
// ---------------------------------------------------------------------------

/**
 * Rate-card rate shape (stored as JSON on CadRateCard.rates). All USD.
 * - setupUsd: one-time setup/tooling fee per order.
 * - perUnitUsd: per-unit fabrication cost (PCB / CNC).
 * - perCm3Usd: per-cm³ machine+material rate (3D print), applied to the
 *   mesh volume estimate × quantity.
 * A card may carry a `source` pointer when its numbers were ingested from a
 * vendor page / datasheet — clean-sourcing; hand-entered cards have none.
 */
export interface RateCardRates {
  setupUsd?: number;
  perUnitUsd?: number;
  perCm3Usd?: number;
  notes?: string;
}

export function validateRateCardRates(input: unknown): RateCardRates {
  if (input == null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new CadError("INVALID_RATE_CARD", "Rates must be an object.");
  }
  const o = input as Record<string, unknown>;
  const out: RateCardRates = {};
  for (const key of ["setupUsd", "perUnitUsd", "perCm3Usd"] as const) {
    if (o[key] != null) {
      const n = Number(o[key]);
      if (!Number.isFinite(n) || n < 0) {
        throw new CadError("INVALID_RATE_CARD", `Rate "${key}" must be a non-negative number.`);
      }
      out[key] = n;
    }
  }
  if (o.notes != null) out.notes = String(o.notes).slice(0, 500);
  return out;
}

export interface RateCardInput {
  name: string;
  process: string;
  currency?: string;
  rates?: unknown;
  isDefault?: boolean;
  /** Source pointer for ingested reference data (URL + accessed date). */
  source?: string;
}

export function validateRateCardInput(input: RateCardInput): {
  name: string;
  process: ExportProcess;
  currency: string;
  rates: RateCardRates;
  isDefault: boolean;
  source?: string;
} {
  const name = String(input.name ?? "").trim();
  if (!name) throw new CadError("INVALID_RATE_CARD", "A rate card name is required.");
  if (!isExportProcess(String(input.process ?? ""))) {
    throw new CadError("INVALID_RATE_CARD", `Process must be one of ${EXPORT_PROCESSES.map((p) => p.value).join(", ")}.`);
  }
  const currency = String(input.currency ?? "USD").trim().toUpperCase() || "USD";
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new CadError("INVALID_RATE_CARD", "Currency must be a 3-letter ISO code.");
  }
  return {
    name,
    process: input.process as ExportProcess,
    currency,
    rates: validateRateCardRates(input.rates),
    isDefault: Boolean(input.isDefault),
    source: input.source?.trim() || undefined,
  };
}

/** Geometry the estimate may honestly use. Nulls stay null. */
export interface EstimateGeometry {
  /** Signed-tetrahedra mesh-volume estimate in mm³ (mesh units are mm, assumed). Null for STEP/unparseable. */
  volumeEstimateMm3: number | null;
}

export interface EstimateInput {
  bomRollup: BomRollup;
  rates: RateCardRates;
  rateCardId: string;
  rateCardName: string;
  process: ExportProcess;
  quantity: number;
  currency: string;
  geometry: EstimateGeometry;
}

export interface CostBreakdown {
  isEstimate: true;
  currency: string;
  quantity: number;
  bomTotalUsd: number;
  /** BOM total × quantity. */
  bomExtendedUsd: number;
  process: {
    setupUsd: number | null;
    /** Volume-driven component (3D print): perCm3Usd × volumeCm3 × qty. Null when uncomputable. */
    volumeComponentUsd: number | null;
    /** Per-unit component (PCB/CNC): perUnitUsd × qty. Null when uncomputable. */
    perUnitComponentUsd: number | null;
    totalUsd: number;
    volumeCm3: number | null;
  };
  grandTotalUsd: number;
  /** grandTotal ÷ quantity; null when quantity is 0. */
  perUnitUsd: number | null;
  rateCard: { id: string; name: string };
  warnings: string[];
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Cost estimate. Pure: given a BOM rollup, a rate card, a quantity, and the
 * version's real geometry, produces a labeled estimate. Numbers that cannot
 * be computed honestly come back null with a warning — they are never
 * invented. This is NOT a vendor quote.
 */
export function computeCostEstimate(input: EstimateInput): CostBreakdown {
  const { bomRollup, rates, process, quantity } = input;
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new CadError("INVALID_QUANTITY", "Quantity must be a positive number.");
  }
  const warnings: string[] = [];
  if (bomRollup.linesMissingCost > 0) {
    warnings.push(
      `${bomRollup.linesMissingCost} BOM line(s) have no unit cost and contribute $0 — the BOM total is a lower bound, not a promise.`,
    );
  }
  if (bomRollup.lineCount === 0) {
    warnings.push("The BOM is empty — the estimate covers process cost only.");
  }

  const bomExtendedUsd = round2(bomRollup.totalUsd * quantity);

  const setupUsd = rates.setupUsd ?? null;
  let volumeComponentUsd: number | null = null;
  let perUnitComponentUsd: number | null = null;
  let volumeCm3: number | null = null;

  if (process === "3d_print") {
    if (rates.perCm3Usd == null) {
      warnings.push("This rate card has no per-cm³ print rate — the volume-driven cost component is unavailable.");
    } else if (input.geometry.volumeEstimateMm3 == null) {
      // STEP and unparseable formats land here: no mesh volume, no guess.
      warnings.push(
        "No mesh volume available for this version (STEP/unparseable) — volume-based print cost is unavailable; only the setup fee is applied.",
      );
    } else {
      volumeCm3 = round2(input.geometry.volumeEstimateMm3 / 1000);
      volumeComponentUsd = round2(rates.perCm3Usd * volumeCm3 * quantity);
    }
  } else {
    // pcb / cnc
    if (rates.perUnitUsd == null) {
      warnings.push(`This rate card has no per-unit ${exportProcessLabel(process)} rate — the per-unit cost component is unavailable.`);
    } else {
      perUnitComponentUsd = round2(rates.perUnitUsd * quantity);
    }
  }

  const processTotalUsd = round2((setupUsd ?? 0) + (volumeComponentUsd ?? 0) + (perUnitComponentUsd ?? 0));
  const grandTotalUsd = round2(bomExtendedUsd + processTotalUsd);

  return {
    isEstimate: true,
    currency: input.currency,
    quantity,
    bomTotalUsd: bomRollup.totalUsd,
    bomExtendedUsd,
    process: {
      setupUsd,
      volumeComponentUsd,
      perUnitComponentUsd,
      totalUsd: processTotalUsd,
      volumeCm3,
    },
    grandTotalUsd,
    perUnitUsd: quantity > 0 ? round2(grandTotalUsd / quantity) : null,
    rateCard: { id: input.rateCardId, name: input.rateCardName },
    warnings,
  };
}

/** Cost comparison across two persisted estimates (e.g. version N vs N+1). */
export interface EstimateDelta {
  fromEstimateId: string;
  toEstimateId: string;
  bomTotalDeltaUsd: number;
  processCostDeltaUsd: number;
  grandTotalDeltaUsd: number;
  perUnitDeltaUsd: number | null;
}

export function compareCostEstimates(
  from: { id: string; basis: CostBreakdown },
  to: { id: string; basis: CostBreakdown },
): EstimateDelta {
  return {
    fromEstimateId: from.id,
    toEstimateId: to.id,
    bomTotalDeltaUsd: round2(to.basis.bomExtendedUsd - from.basis.bomExtendedUsd),
    processCostDeltaUsd: round2(to.basis.process.totalUsd - from.basis.process.totalUsd),
    grandTotalDeltaUsd: round2(to.basis.grandTotalUsd - from.basis.grandTotalUsd),
    perUnitDeltaUsd:
      to.basis.perUnitUsd != null && from.basis.perUnitUsd != null
        ? round2(to.basis.perUnitUsd - from.basis.perUnitUsd)
        : null,
  };
}

// ---------------------------------------------------------------------------
// Export requests / quote requests
// ---------------------------------------------------------------------------

export const QUOTE_STATUSES = ["draft", "confirmed", "sent"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export function isQuoteStatus(v: string): v is QuoteStatus {
  return (QUOTE_STATUSES as readonly string[]).includes(v);
}

export interface ExportRequestInput {
  process: string;
  quantity: number;
  processOptions?: unknown;
  contact?: unknown;
}

export function validateExportRequestInput(input: ExportRequestInput): {
  process: ExportProcess;
  quantity: number;
  processOptions: ProcessOptions;
  contact: ContactDetails;
} {
  if (!isExportProcess(String(input.process ?? ""))) {
    throw new CadError("INVALID_PROCESS", `Process must be one of ${EXPORT_PROCESSES.map((p) => p.value).join(", ")}.`);
  }
  const quantity = Number(input.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(quantity)) {
    throw new CadError("INVALID_QUANTITY", "Quantity must be a positive integer.");
  }
  const process = input.process as ExportProcess;
  return {
    process,
    quantity,
    processOptions: validateProcessOptions(process, input.processOptions),
    contact: validateContact(input.contact),
  };
}

/** The v1 no-live-vendor boundary, stated in one place and referenced by code, UI, and tests. */
export const NO_LIVE_VENDOR_API_MESSAGE =
  "v1 does not connect to vendor APIs and does not place orders. The export package is for the tenant to submit to their chosen vendor through their own account; recording a send only logs who sent it, when, to whom, and via which connected account.";

export interface ExportManifest {
  package: "cad-export";
  packageVersion: 1;
  generatedAt: string;
  model: { id: string; name: string; projectId: string };
  version: {
    id: string;
    versionNumber: number;
    format: string;
    fileName: string;
    sizeBytes: number;
    sha256: string;
    uploadedAt: string;
  };
  quoteRequestId: string;
  process: { process: ExportProcess; quantity: number; options: ProcessOptions };
  contact: ContactDetails;
  bom: null | {
    bomVersionId: string;
    bomNumber: number;
    pinnedVersionNumber: number;
    lines: {
      partName: string;
      qty: number;
      unitName: string;
      materialSpec?: string;
      supplier?: string;
      unitCostUsd: number | null;
      source: string;
    }[];
    rollup: BomRollup;
  };
  estimate: null | {
    estimateId: string;
    grandTotalUsd: number;
    perUnitUsd: number | null;
    currency: string;
    rateCardName: string;
  };
  noLiveVendorApi: true;
  disclaimer: string;
}

/**
 * Builds the vendor-ready export package manifest. Pure — the store writes
 * it to disk at confirm time and serves it at download time.
 */
export function buildExportManifest(args: {
  request: { id: string; process: ExportProcess; quantity: number; processOptions: ProcessOptions; contact: ContactDetails };
  model: { id: string; name: string; projectId: string };
  version: {
    id: string;
    versionNumber: number;
    format: string;
    fileName: string;
    sizeBytes: number;
    checksum: string;
    uploadedAt: Date;
  };
  bom: null | {
    id: string;
    bomNumber: number;
    lines: {
      partName: string;
      qty: number;
      unitName: string;
      materialSpec?: string;
      supplier?: string;
      unitCostUsd: number | null;
      source: string;
    }[];
    rollup: BomRollup;
  };
  estimate: null | {
    id: string;
    grandTotalUsd: number;
    perUnitUsd: number | null;
    currency: string;
    rateCardName: string;
  };
  generatedAt?: Date;
}): ExportManifest {
  return {
    package: "cad-export",
    packageVersion: 1,
    generatedAt: (args.generatedAt ?? new Date()).toISOString(),
    model: args.model,
    version: {
      id: args.version.id,
      versionNumber: args.version.versionNumber,
      format: args.version.format,
      fileName: args.version.fileName,
      sizeBytes: args.version.sizeBytes,
      sha256: args.version.checksum,
      uploadedAt: args.version.uploadedAt.toISOString(),
    },
    quoteRequestId: args.request.id,
    process: {
      process: args.request.process,
      quantity: args.request.quantity,
      options: args.request.processOptions,
    },
    contact: args.request.contact,
    bom: args.bom
      ? {
          bomVersionId: args.bom.id,
          bomNumber: args.bom.bomNumber,
          pinnedVersionNumber: args.version.versionNumber,
          lines: args.bom.lines,
          rollup: args.bom.rollup,
        }
      : null,
    estimate: args.estimate
      ? {
          estimateId: args.estimate.id,
          grandTotalUsd: args.estimate.grandTotalUsd,
          perUnitUsd: args.estimate.perUnitUsd,
          currency: args.estimate.currency,
          rateCardName: args.estimate.rateCardName,
        }
      : null,
    noLiveVendorApi: true,
    disclaimer: NO_LIVE_VENDOR_API_MESSAGE,
  };
}
