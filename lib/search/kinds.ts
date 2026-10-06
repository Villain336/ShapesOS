// ShapesOS — record search kinds and labels (Phase 4a; Spotlight Phase 18.1).
// Client-safe: the command bar imports these; the server search lives in
// ./records.ts and the per-kind sources in ./sources (one file each).
//
// Adding a kind: append it here (the order is the tie-break order between
// equally good groups), add a source file in lib/search/sources and list it
// in sources/index.ts, and add `records.kinds.<kind>` to lib/i18n/messages
// en.ts + es.ts. The unit tests check all four stay in step.

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
  // Phase 4b
  "bom_line",
  "dataset",
  "social_post",
  // Phase 18.1 (Spotlight)
  "file_content",
  "chat_message",
  "inbox_message",
  "contact",
  "company",
  "person",
  "ticket",
  "deal",
  "app",
  // Phase 18.2 (WS=comms): the member's own mail threads (the Mail app).
  "mail",
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

/** English labels (the i18n catalogue's records.kinds has the translations). */
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
  bom_line: "BOM part",
  dataset: "Dataset",
  social_post: "Social post",
  file_content: "Inside files and docs",
  chat_message: "Chat message",
  inbox_message: "Conversation",
  contact: "Contact",
  company: "Company",
  person: "Person",
  ticket: "Ticket",
  deal: "Deal",
  app: "App",
  mail: "Mail",
};

/** How a result matched (Spotlight shows these; the ranking blends them). */
export const MATCH_MODES = ["name", "text", "meaning"] as const;
export type MatchMode = (typeof MATCH_MODES)[number];

/**
 * Words a person can type to narrow Spotlight to kinds ("kind:file",
 * "in:tickets", "type:deal"). Client-safe so the palette can show them.
 */
export const KIND_ALIASES: Record<string, readonly RecordKind[]> = {
  lead: ["lead"],
  leads: ["lead"],
  invoice: ["invoice"],
  invoices: ["invoice"],
  doc: ["doc"],
  docs: ["doc"],
  document: ["doc", "file_content"],
  documents: ["doc", "file_content"],
  file: ["file", "file_content"],
  files: ["file", "file_content"],
  project: ["project", "ops_project"],
  projects: ["project", "ops_project"],
  mission: ["mission"],
  missions: ["mission"],
  cad: ["cad_project", "bom_line"],
  esign: ["envelope"],
  envelope: ["envelope"],
  legal: ["legal_document"],
  client: ["client"],
  clients: ["client"],
  dataset: ["dataset"],
  datasets: ["dataset"],
  social: ["social_post"],
  post: ["social_post"],
  posts: ["social_post"],
  chat: ["chat_message"],
  chats: ["chat_message"],
  message: ["chat_message", "inbox_message"],
  messages: ["chat_message", "inbox_message"],
  inbox: ["inbox_message"],
  conversation: ["inbox_message"],
  conversations: ["inbox_message"],
  contact: ["contact", "person", "lead"],
  contacts: ["contact", "person", "lead"],
  company: ["company"],
  companies: ["company"],
  person: ["person"],
  people: ["person", "contact"],
  ticket: ["ticket"],
  tickets: ["ticket"],
  deal: ["deal"],
  deals: ["deal"],
  app: ["app"],
  apps: ["app"],
  // Phase 18.2 (WS=comms)
  mail: ["mail"],
  email: ["mail", "inbox_message"],
  emails: ["mail", "inbox_message"],
};
