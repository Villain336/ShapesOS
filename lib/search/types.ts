// ShapesOS — Phase 18.1 (WS=find): the Spotlight source contract.
//
// A source is one record kind: who may read it (minRole + its own visibility
// predicate inside the SQL — personal chats, unpublished drafts), how it
// matches (name / full text / meaning), how a row becomes a result, and the
// agent actions "Act on it" offers (tools from the existing registry; their
// tiers are unchanged — a write still asks first).

import type { Prisma, WorkspaceRole } from "@prisma/client";
import type { MatchMode, RecordKind } from "./kinds";
import type { ParsedQuery } from "./query";

export type Tx = Prisma.TransactionClient;

export interface SearchCtx {
  workspaceId: string;
  role: WorkspaceRole;
  /** The person searching (personal records such as chats are theirs only). */
  userId: string | null;
  q: ParsedQuery;
  /** ILIKE pattern of q.name (null when there is no name text to match). */
  pattern: string | null;
  limit: number;
  /** pgvector literal of the query embedding, when semantic search runs. */
  vector: string | null;
}

/** What every source query returns (snake_case straight from SQL). */
export interface SourceRow {
  id: string;
  title: string | null;
  sub: string | null;
  extra: string | null;
  n: number | null;
  updated_at: Date | null;
  name_sim: number | null;
  name_hit: boolean | null;
  fts_rank: number | null;
  vsim: number | null;
  snippet: string | null;
}

export interface HitFields {
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
  /** Workspace file id / Office doc id the "Ask about this" context can carry. */
  ref?: { fileId?: string; docId?: string; leadId?: string; threadId?: string };
}

/** "Act on it": a record's primary agent action, run through the tool registry. */
export interface SourceAction {
  /** Stable id; the label is `commandBar.spotlight.actions.<id>` in the catalogues. */
  id: string;
  /** The registered tool the agent will use (lib/chat/tools.ts). */
  tool: string;
  /** English instruction handed to the lead agent with the record reference. */
  instruction: string;
}

export interface SearchSource {
  kind: RecordKind;
  /** Minimum workspace role — the read gate of the page the result opens. */
  minRole: WorkspaceRole;
  /** The match modes this source supports. */
  modes: readonly MatchMode[];
  query(tx: Tx, ctx: SearchCtx): Promise<SourceRow[]>;
  hit(row: SourceRow): HitFields;
  actions?: readonly SourceAction[];
}
