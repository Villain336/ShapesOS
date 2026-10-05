// ShapesOS — Phase 11 (devtools): Linear GraphQL API (OAuth bearer token).
//
//   POST https://api.linear.app/graphql   (every call; queries and mutations)
// Docs: https://linear.app/developers/graphql (schema: issues, teams,
// projects, searchIssues, issueCreate, issueUpdate, commentCreate, viewer).
//
// Linear answers GraphQL errors as { errors: [{ message, extensions: { code } }] }
// — with HTTP 200 for most query errors and HTTP 400 for rate limits
// (extensions.code "RATELIMITED"). linearClassify maps both onto the closed
// connector error codes; reads back off on RATELIMITED through liveRequest,
// mutations are never retried (a retry could create the issue twice).
// The OAuth token is a vault credential; liveRequest scrubs it from errors.

import {
  ConnectorApiError,
  clampInt,
  defaultClassify,
  liveRequest,
  type Classification,
  type ConnectorErrorCode,
  type LiveDeps,
  type TokenSource,
} from "./http";

export const LINEAR_GRAPHQL = "https://api.linear.app/graphql";
const PROVIDER = "Linear";

interface GqlError {
  message?: string;
  extensions?: { code?: string; type?: string };
}

/** Linear GraphQL error code → closed connector error code. PURE. */
export function linearErrorCode(code: string | undefined): ConnectorErrorCode {
  switch ((code ?? "").toUpperCase()) {
    case "RATELIMITED":
      return "rate_limited";
    case "AUTHENTICATION_ERROR":
      return "auth_rejected";
    case "FORBIDDEN":
      return "forbidden";
    case "ENTITY_NOT_FOUND":
    case "NOT_FOUND":
      return "not_found";
    case "INTERNAL_SERVER_ERROR":
      return "provider_error";
    default:
      return "bad_request";
  }
}

function firstError(body: unknown): GqlError | undefined {
  const errs = (body as { errors?: unknown } | null)?.errors;
  return Array.isArray(errs) && errs.length ? (errs[0] as GqlError) : undefined;
}

/** HTTP-level classifier: a GraphQL error envelope wins over the status. */
export function linearClassify(status: number, body: unknown): Classification {
  const e = firstError(body);
  if (e) {
    const code = linearErrorCode(e.extensions?.code);
    return {
      code,
      retryable: code === "rate_limited" || code === "provider_error",
      authExpired: code === "auth_rejected",
      message: e.message,
    };
  }
  return defaultClassify(status, body);
}

/** One GraphQL call. `write` disables retries (mutations are never retried). */
async function gql<T>(auth: TokenSource, query: string, variables: Record<string, unknown>, deps: LiveDeps, write = false): Promise<T> {
  const res = await liveRequest<{ data?: T; errors?: GqlError[] }>(
    { provider: PROVIDER, url: LINEAR_GRAPHQL, method: "POST", json: { query, variables }, auth, classify: linearClassify },
    write ? { ...deps, maxRetries: 0 } : deps,
  );
  const e = firstError(res);
  if (e || !res?.data) {
    const code = e ? linearErrorCode(e.extensions?.code) : "provider_error";
    throw new ConnectorApiError(PROVIDER, code, `Linear request failed: ${String(e?.message ?? "no data returned").slice(0, 200)}`);
  }
  return res.data;
}

// --------------------------------------------------------------- shapes

const ISSUE_FIELDS = "id identifier title priority url updatedAt state { name type } assignee { name } team { key } project { name }";

interface RawIssue {
  id?: string;
  identifier?: string;
  title?: string;
  priority?: number;
  url?: string;
  updatedAt?: string;
  state?: { name?: string; type?: string } | null;
  assignee?: { name?: string } | null;
  team?: { key?: string } | null;
  project?: { name?: string } | null;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  priority: number;
  state: string | null;
  stateType: string | null;
  assignee: string | null;
  team: string | null;
  project: string | null;
  url: string | null;
  updatedAt: string | null;
}

const toIssue = (i: RawIssue): LinearIssue => ({
  id: String(i.id ?? ""),
  identifier: String(i.identifier ?? ""),
  title: String(i.title ?? "").slice(0, 500),
  priority: Number(i.priority ?? 0),
  state: i.state?.name ?? null,
  stateType: i.state?.type ?? null,
  assignee: i.assignee?.name ?? null,
  team: i.team?.key ?? null,
  project: i.project?.name ?? null,
  url: i.url ?? null,
  updatedAt: i.updatedAt ?? null,
});

interface Connection<N> {
  nodes?: N[];
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
}

// --------------------------------------------------------------- input checks

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER_RE = /^[A-Z][A-Z0-9_]{0,9}-\d{1,7}$/;

/** A Linear entity id (UUID). Issues also accept the "ENG-123" identifier. */
export function linearIdOf(v: unknown, field: string, allowIdentifier = false): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new Error(`${field} is required.`);
  if (UUID_RE.test(s) || (allowIdentifier && IDENTIFIER_RE.test(s))) return s;
  throw new Error(`${field} must be a Linear id${allowIdentifier ? ' or an issue key like "ENG-123"' : ""}.`);
}

function optText(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

function optPriority(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 4) throw new Error("priority must be 0 (none), 1 (urgent), 2 (high), 3 (medium) or 4 (low).");
  return n;
}

const STATE_TYPES = new Set(["triage", "backlog", "unstarted", "started", "completed", "canceled"]);

// --------------------------------------------------------------- reads

export async function linearViewer(auth: TokenSource, deps: LiveDeps = {}): Promise<{ id: string; name: string }> {
  const d = await gql<{ viewer?: { id?: string; name?: string } }>(auth, "query { viewer { id name } }", {}, deps);
  return { id: String(d.viewer?.id ?? ""), name: String(d.viewer?.name ?? "") };
}

export async function linearListTeams(auth: TokenSource, deps: LiveDeps = {}): Promise<Array<{ id: string; key: string; name: string }>> {
  const d = await gql<{ teams?: Connection<{ id?: string; key?: string; name?: string }> }>(
    auth,
    "query Teams { teams(first: 100) { nodes { id key name } } }",
    {},
    deps,
  );
  return (d.teams?.nodes ?? []).map((t) => ({ id: String(t.id ?? ""), key: String(t.key ?? ""), name: String(t.name ?? "") }));
}

export async function linearListProjects(
  auth: TokenSource,
  opts: { limit?: unknown } = {},
  deps: LiveDeps = {},
): Promise<Array<{ id: string; name: string; state: string | null; progress: number | null; targetDate: string | null; url: string | null }>> {
  const first = clampInt(opts.limit, 50, 1, 100);
  const d = await gql<{ projects?: Connection<{ id?: string; name?: string; state?: string; progress?: number; targetDate?: string; url?: string }> }>(
    auth,
    "query Projects($first: Int!) { projects(first: $first) { nodes { id name state progress targetDate url } } }",
    { first },
    deps,
  );
  return (d.projects?.nodes ?? []).map((p) => ({
    id: String(p.id ?? ""),
    name: String(p.name ?? ""),
    state: p.state ?? null,
    progress: typeof p.progress === "number" ? p.progress : null,
    targetDate: p.targetDate ?? null,
    url: p.url ?? null,
  }));
}

/**
 * Issues, newest-updated first, optionally filtered by team and state type.
 * Pages through Linear's cursor connection (50 per page) up to `limit`
 * (max 250); returns the cursor to continue from when more remain.
 */
export async function linearListIssues(
  auth: TokenSource,
  opts: { teamId?: unknown; stateType?: unknown; limit?: unknown; cursor?: unknown } = {},
  deps: LiveDeps = {},
): Promise<{ issues: LinearIssue[]; nextCursor: string | null }> {
  const limit = clampInt(opts.limit, 25, 1, 250);
  const filter: Record<string, unknown> = {};
  if (opts.teamId !== undefined && opts.teamId !== null && opts.teamId !== "") filter.team = { id: { eq: linearIdOf(opts.teamId, "teamId") } };
  if (opts.stateType !== undefined && opts.stateType !== null && opts.stateType !== "") {
    const st = String(opts.stateType).trim().toLowerCase();
    if (!STATE_TYPES.has(st)) throw new Error(`stateType must be one of ${[...STATE_TYPES].join(", ")}.`);
    filter.state = { type: { eq: st } };
  }
  const issues: LinearIssue[] = [];
  let after: string | null = typeof opts.cursor === "string" && opts.cursor.trim() ? opts.cursor.trim().slice(0, 500) : null;
  let more = true;
  while (more && issues.length < limit) {
    const d = await gql<{ issues?: Connection<RawIssue> }>(
      auth,
      `query Issues($first: Int!, $after: String, $filter: IssueFilter) { issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
      { first: Math.min(50, limit - issues.length), after, filter: Object.keys(filter).length ? filter : null },
      deps,
    );
    for (const n of d.issues?.nodes ?? []) issues.push(toIssue(n));
    more = d.issues?.pageInfo?.hasNextPage === true && Boolean(d.issues?.pageInfo?.endCursor);
    after = more ? String(d.issues?.pageInfo?.endCursor) : null;
  }
  return { issues, nextCursor: more ? after : null };
}

export async function linearSearchIssues(
  auth: TokenSource,
  opts: { query?: unknown; limit?: unknown },
  deps: LiveDeps = {},
): Promise<LinearIssue[]> {
  const term = optText(opts.query, 300);
  if (!term) throw new Error("query is required.");
  const first = clampInt(opts.limit, 25, 1, 50);
  const d = await gql<{ searchIssues?: Connection<RawIssue> }>(
    auth,
    `query Search($term: String!, $first: Int!) { searchIssues(term: $term, first: $first) { nodes { ${ISSUE_FIELDS} } } }`,
    { term, first },
    deps,
  );
  return (d.searchIssues?.nodes ?? []).map(toIssue);
}

// --------------------------------------------------------------- writes (never retried)

export async function linearCreateIssue(
  auth: TokenSource,
  opts: { teamId?: unknown; title?: unknown; description?: unknown; priority?: unknown; assigneeId?: unknown; projectId?: unknown; stateId?: unknown },
  deps: LiveDeps = {},
): Promise<{ id: string; identifier: string; title: string; url: string | null }> {
  const title = optText(opts.title, 250);
  if (!title) throw new Error("title is required.");
  const input: Record<string, unknown> = { teamId: linearIdOf(opts.teamId, "teamId"), title };
  const description = optText(opts.description, 50_000);
  if (description) input.description = description;
  const priority = optPriority(opts.priority);
  if (priority !== undefined) input.priority = priority;
  for (const k of ["assigneeId", "projectId", "stateId"] as const) {
    if (opts[k] !== undefined && opts[k] !== null && opts[k] !== "") input[k] = linearIdOf(opts[k], k);
  }
  const d = await gql<{ issueCreate?: { success?: boolean; issue?: RawIssue } }>(
    auth,
    "mutation Create($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title url } } }",
    { input },
    deps,
    true,
  );
  if (!d.issueCreate?.success || !d.issueCreate.issue?.id) throw new ConnectorApiError(PROVIDER, "provider_error", "Linear did not create the issue.");
  const i = d.issueCreate.issue;
  return { id: String(i.id), identifier: String(i.identifier ?? ""), title: String(i.title ?? title), url: i.url ?? null };
}

export async function linearUpdateIssue(
  auth: TokenSource,
  opts: { issueId?: unknown; title?: unknown; description?: unknown; priority?: unknown; assigneeId?: unknown; stateId?: unknown; projectId?: unknown },
  deps: LiveDeps = {},
): Promise<{ id: string; identifier: string; title: string; state: string | null; url: string | null }> {
  const id = linearIdOf(opts.issueId, "issueId", true);
  const input: Record<string, unknown> = {};
  const title = optText(opts.title, 250);
  if (title) input.title = title;
  const description = optText(opts.description, 50_000);
  if (description) input.description = description;
  const priority = optPriority(opts.priority);
  if (priority !== undefined) input.priority = priority;
  for (const k of ["assigneeId", "stateId", "projectId"] as const) {
    if (opts[k] !== undefined && opts[k] !== null && opts[k] !== "") input[k] = linearIdOf(opts[k], k);
  }
  if (Object.keys(input).length === 0) throw new Error("Nothing to update — give a title, description, priority, assigneeId, stateId or projectId.");
  const d = await gql<{ issueUpdate?: { success?: boolean; issue?: RawIssue } }>(
    auth,
    "mutation Update($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id identifier title url state { name type } } } }",
    { id, input },
    deps,
    true,
  );
  if (!d.issueUpdate?.success || !d.issueUpdate.issue?.id) throw new ConnectorApiError(PROVIDER, "provider_error", "Linear did not update the issue.");
  const i = d.issueUpdate.issue;
  return { id: String(i.id), identifier: String(i.identifier ?? ""), title: String(i.title ?? ""), state: i.state?.name ?? null, url: i.url ?? null };
}

export async function linearAddComment(
  auth: TokenSource,
  opts: { issueId?: unknown; body?: unknown },
  deps: LiveDeps = {},
): Promise<{ id: string; url: string | null }> {
  const issueId = linearIdOf(opts.issueId, "issueId", true);
  const body = optText(opts.body, 50_000);
  if (!body) throw new Error("body is required.");
  const d = await gql<{ commentCreate?: { success?: boolean; comment?: { id?: string; url?: string } } }>(
    auth,
    "mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }",
    { input: { issueId, body } },
    deps,
    true,
  );
  if (!d.commentCreate?.success || !d.commentCreate.comment?.id) throw new ConnectorApiError(PROVIDER, "provider_error", "Linear did not add the comment.");
  return { id: String(d.commentCreate.comment.id), url: d.commentCreate.comment.url ?? null };
}
