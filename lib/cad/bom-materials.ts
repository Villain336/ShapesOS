// ShapesOS — CAD derived BOM material library (Phase 4b). Client-safe (no
// imports): the CAD UI lists these, lib/cad/bom-derive.ts uses the densities.

export interface BomMaterial {
  key: string;
  label: string;
  /** g/cm³ */
  densityGPerCm3: number;
  category: "polymer" | "metal" | "composite";
  /** Where the density comes from (clean sourcing: no orphaned numbers). */
  source: string;
}

const HANDBOOK = "Typical handbook density at room temperature — confirm against your supplier's datasheet";

/**
 * Library densities: widely published nominal values, labeled as typical.
 * A tenant with a datasheet figure enters a custom material instead.
 */
export const BOM_MATERIALS: readonly BomMaterial[] = [
  { key: "pla", label: "PLA", densityGPerCm3: 1.24, category: "polymer", source: HANDBOOK },
  { key: "abs", label: "ABS", densityGPerCm3: 1.04, category: "polymer", source: HANDBOOK },
  { key: "petg", label: "PETG", densityGPerCm3: 1.27, category: "polymer", source: HANDBOOK },
  { key: "pa12", label: "Nylon PA12", densityGPerCm3: 1.01, category: "polymer", source: HANDBOOK },
  { key: "polycarbonate", label: "Polycarbonate", densityGPerCm3: 1.2, category: "polymer", source: HANDBOOK },
  { key: "al6061", label: "Aluminium 6061", densityGPerCm3: 2.7, category: "metal", source: HANDBOOK },
  { key: "steel", label: "Carbon steel", densityGPerCm3: 7.85, category: "metal", source: HANDBOOK },
  { key: "ss304", label: "Stainless steel 304", densityGPerCm3: 8.0, category: "metal", source: HANDBOOK },
  { key: "ti64", label: "Titanium Ti-6Al-4V", densityGPerCm3: 4.43, category: "metal", source: HANDBOOK },
  { key: "brass", label: "Brass", densityGPerCm3: 8.5, category: "metal", source: HANDBOOK },
  { key: "cfrp", label: "Carbon fibre composite", densityGPerCm3: 1.55, category: "composite", source: HANDBOOK },
  { key: "fr4", label: "FR-4", densityGPerCm3: 1.85, category: "composite", source: HANDBOOK },
];

export function findMaterial(key: string): BomMaterial | undefined {
  return BOM_MATERIALS.find((m) => m.key === key);
}
