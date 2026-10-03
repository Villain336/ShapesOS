// ShapesOS — record search kinds and labels (Phase 4a). Client-safe: the
// command bar imports these; the server search lives in ./records.ts.

export const RECORD_KINDS = [
  "lead",
  "invoice",
  "doc",
  "file",
  "project",
  "ops_project",
  "mission",
  "cad_project",
  "envelope",
  "legal_document",
  "client",
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export const RECORD_KIND_LABELS: Record<RecordKind, string> = {
  lead: "Lead",
  invoice: "Invoice",
  doc: "Doc",
  file: "File",
  project: "SEO project",
  ops_project: "Project",
  mission: "Mission",
  cad_project: "CAD project",
  envelope: "E-sign",
  legal_document: "Legal",
  client: "Client",
};
