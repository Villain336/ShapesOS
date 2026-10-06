// ShapesOS — Phase 18.2 (WS=content): where a linked record opens (PURE,
// client-safe). The same destinations Spotlight's sources open
// (lib/search/sources/*: hit().href), keyed by record kind, so a note's
// "linked to" chip lands on the record's own page.

import type { RecordKind } from "@/lib/search/kinds";

const e = encodeURIComponent;

const HREF: Partial<Record<RecordKind, (id: string) => string>> = {
  lead: (id) => `/dashboard/crm?lead=${e(id)}`,
  contact: (id) => `/dashboard/crm?tab=contacts&contact=${e(id)}`,
  company: (id) => `/dashboard/crm?tab=companies&company=${e(id)}`,
  deal: (id) => `/dashboard/crm?tab=deals&deal=${e(id)}`,
  inbox_message: () => "/dashboard/crm/inbox",
  invoice: (id) => `/dashboard/ops/invoices?invoice=${e(id)}`,
  ops_project: () => "/dashboard/ops/projects",
  ticket: (id) => `/dashboard/ops/helpdesk?ticket=${e(id)}`,
  person: (id) => `/dashboard/connector?person=${e(id)}`,
  chat_message: () => "/dashboard/assistant",
  doc: (id) => `/dashboard/office?open=${e(id)}`,
  file: (id) => `/dashboard/files?file=${e(id)}`,
  file_content: (id) => `/dashboard/files?file=${e(id)}`,
  project: (id) => `/dashboard/projects/${e(id)}`,
  mission: (id) => `/dashboard/missions/${e(id)}`,
  cad_project: (id) => `/dashboard/cad?project=${e(id)}`,
  envelope: () => "/dashboard/esign",
  legal_document: () => "/dashboard/legal",
  client: () => "/dashboard/settings/clients",
  bom_line: () => "/dashboard/cad",
  dataset: () => "/dashboard/datasets?tab=build",
  social_post: (id) => `/dashboard/social?post=${e(id)}`,
  app: () => "/dashboard/apps",
  note: (id) => `/dashboard/notes?note=${e(id)}`,
};

export function recordHref(kind: string, id: string): string {
  const f = HREF[kind as RecordKind];
  return f ? f(id) : "/dashboard";
}
