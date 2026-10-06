// ShapesOS — Phase 18.1 (WS=find): the Spotlight source registry.
//
// HOW TO ADD A SOURCE (e.g. Notes and Mail in 18.2):
//   1. Write lib/search/sources/<area>.ts exporting a SearchSource
//      (lib/search/types.ts): its kind, the minimum role of the page it opens,
//      its own visibility rule inside `scope` (personal rows, drafts), and
//      either a tableSearch() spec (name ILIKE + indexed full text) or its own
//      SQL. If it has full text, add its document to lib/search/fts.ts and a
//      migration creating "<table>_search_tsv_idx" with ftsIndexSql(); if it
//      has long text worth meaning-search, index it into search_texts
//      (lib/search/text-index.ts) instead.
//   2. List it in SOURCES below and its kind in lib/search/kinds.ts.
//   3. Add `records.kinds.<kind>` (and any `commandBar.spotlight.actions.<id>`)
//      to lib/i18n/messages/en.ts + es.ts.
//   4. Add it to lib/search/__tests__/spotlight-db.test.ts: found, scoped to
//      its workspace, and hidden from whoever its page hides it from.
// The unit tests fail until kinds, registry and catalogues agree.

import type { RecordKind } from "../kinds";
import type { SearchSource } from "../types";
import { company, contact, deal, inboxMessage, lead } from "./crm";
import { invoice, opsProject, ticket } from "./ops";
import { app, bomLine, cadProject, client, dataset, doc, envelope, file, legalDocument, mission, project, socialPost } from "./work";
import { chatMessage, person } from "./people";
import { fileContent } from "./content";
// Phase 18.2 (WS=comms)
import { mail } from "./comms";

export const SOURCES: readonly SearchSource[] = [
  lead,
  invoice,
  doc,
  file,
  project,
  opsProject,
  mission,
  cadProject,
  envelope,
  legalDocument,
  client,
  bomLine,
  dataset,
  socialPost,
  fileContent,
  chatMessage,
  inboxMessage,
  contact,
  company,
  person,
  ticket,
  deal,
  app,
  // Phase 18.2 (WS=comms)
  mail,
];

export const SOURCE_BY_KIND: ReadonlyMap<RecordKind, SearchSource> = new Map(SOURCES.map((s) => [s.kind, s]));
