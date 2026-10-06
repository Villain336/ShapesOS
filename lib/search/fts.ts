// ShapesOS — Phase 18.1 (WS=find): the full-text documents Spotlight searches.
//
// Each entry is the EXACT text expression a GIN expression index is built on
// in prisma/migrations/20261020200100_p18_find_spotlight (index names end in
// _search_tsv_idx). A query must repeat the expression verbatim for Postgres
// to use the index, so both the migration and lib/search/sources read it from
// here (a unit test checks the migration still matches).
//
// Every document is indexed twice in one vector — the 'simple' config (exact
// words, names, any language) concatenated with 'english' (stems: "invoices"
// finds "invoice") — and queried with
//   websearch_to_tsquery('simple', q) || websearch_to_tsquery('english', q)
// so quoted phrases, OR and -exclusions work like a search engine. Long
// bodies are capped with left(…) so a huge email can never overflow a
// tsvector (1 MB) and fail the write that indexes it. Only IMMUTABLE
// functions are allowed in an index (no concat_ws, no array_to_string).

export const FTS_DOCS = {
  crm_leads: "name || ' ' || coalesce(email, '') || ' ' || coalesce(company, '') || ' ' || coalesce(phone, '') || ' ' || coalesce(title, '')",
  ops_projects: "name",
  missions: "coalesce(goal ->> 'label', template)",
  cad_projects: "name || ' ' || coalesce(description, '')",
  esign_envelopes: "title || ' ' || coalesce(document_name, '')",
  legal_documents: "title || ' ' || left(coalesce(notes, ''), 20000)",
  clients: "name",
  cad_bom_lines: "part_name || ' ' || coalesce(material_spec, '')",
  datasets: "name",
  social_publications: "left(content, 20000)",
  ops_contacts: "name || ' ' || coalesce(email, '') || ' ' || coalesce(phone, '') || ' ' || coalesce(title, '') || ' ' || left(coalesce(notes, ''), 20000)",
  ops_companies: "name || ' ' || coalesce(domain, '') || ' ' || coalesce(website, '') || ' ' || coalesce(industry, '') || ' ' || left(coalesce(notes, ''), 20000)",
  connector_agent_persons: "name",
  ops_tickets: "subject || ' ' || coalesce(requester_name, '') || ' ' || coalesce(requester_email, '')",
  ops_ticket_messages: "left(body, 20000)",
  ops_deals: "title || ' ' || coalesce(owner_name, '') || ' ' || coalesce(lost_reason, '')",
  ai_chat_messages: "left(content, 20000)",
  outbound_message: "coalesce(subject, '') || ' ' || left(body, 20000)",
  mini_apps: "name || ' ' || coalesce(description, '')",
  univer_docs: "title",
} as const;

export type FtsTable = keyof typeof FTS_DOCS;

/** The indexed vector for a table, optionally with a table alias on every column. */
export function ftsVector(table: FtsTable, alias?: string): string {
  const doc = alias ? qualify(FTS_DOCS[table], alias) : FTS_DOCS[table];
  return `(to_tsvector('simple', ${doc}) || to_tsvector('english', ${doc}))`;
}

/** The index statement for a table (the migration's text; tested to match). */
export function ftsIndexSql(table: FtsTable): string {
  return `CREATE INDEX IF NOT EXISTS "${table}_search_tsv_idx" ON "${table}" USING gin (${ftsVector(table)});`;
}

/** The expression with its bare column names prefixed by `alias.` (string literals and functions untouched). */
export function qualify(expr: string, alias: string): string {
  const FUNCS = new Set(["coalesce", "left", "to_tsvector"]);
  let out = "";
  let i = 0;
  while (i < expr.length) {
    const c = expr[i]!;
    if (c === "'") {
      const end = expr.indexOf("'", i + 1);
      out += expr.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (/[a-z_]/.test(c)) {
      let j = i;
      while (j < expr.length && /[a-z0-9_]/.test(expr[j]!)) j++;
      const word = expr.slice(i, j);
      const next = expr.slice(j).trimStart()[0];
      out += FUNCS.has(word) || next === "(" ? word : `${alias}.${word}`;
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
