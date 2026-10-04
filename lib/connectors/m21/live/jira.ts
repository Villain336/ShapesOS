// ShapesOS — Phase 11 (devtools): Jira Cloud REST API v3 (OAuth 2.0 3LO).
//
//   GET  https://api.atlassian.com/oauth/token/accessible-resources → the sites (cloud ids) the grant covers
//   GET  {base}/rest/api/3/project/search                          → projects (startAt pagination)
//   GET  {base}/rest/api/3/search/jql                              → JQL search (nextPageToken pagination)
//   GET  {base}/rest/api/3/issue/{key}                             → one issue
//   POST {base}/rest/api/3/issue                                   → create      [write]
//   GET  {base}/rest/api/3/issue/{key}/transitions                 → available transitions
//   POST {base}/rest/api/3/issue/{key}/transitions                 → transition  [write]
//   POST {base}/rest/api/3/issue/{key}/comment                     → comment     [write]
// where {base} = https://api.atlassian.com/ex/jira/{cloudId}.
// Docs: developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps and the
// REST v3 reference (the enhanced /search/jql replaces the removed /search).
//
// Which site: the project data source's projectConfig.cloudId (or .site, a
// site URL) when set, else the first site the grant can reach with Jira
// scopes. Descriptions and comments are sent as Atlassian Document Format
// built from plain text. Rate limits are HTTP 429 + Retry-After: reads back
// off through liveRequest; writes are never retried.

import {
  ConnectorApiError,
  clampInt,
  defaultClassify,
  liveRequest,
  type Classification,
  type LiveDeps,
  type TokenSource,
} from "./http";

export const ATLASSIAN_API = "https://api.atlassian.com";
const PROVIDER = "Jira";

/** Jira's { errorMessages: [], errors: { field: msg } } envelope → a message. */
export function jiraClassify(status: number, body: unknown): Classification {
  const c = defaultClassify(status, body);
  if (body && typeof body === "object") {
    const b = body as { errorMessages?: unknown; errors?: unknown };
    const first = Array.isArray(b.errorMessages) && b.errorMessages.length ? String(b.errorMessages[0]) : undefined;
    const field =
      b.errors && typeof b.errors === "object" && !Array.isArray(b.errors)
        ? Object.entries(b.errors as Record<string, unknown>).map(([k, v]) => `${k}: ${String(v)}`)[0]
        : undefined;
    if (first || field) return { ...c, message: first ?? field };
  }
  return c;
}

const writeDeps = (deps: LiveDeps): LiveDeps => ({ ...deps, maxRetries: 0 });

// --------------------------------------------------------------- sites

export interface JiraSite {
  cloudId: string;
  url: string;
  name: string;
}

export async function jiraAccessibleSites(auth: TokenSource, deps: LiveDeps = {}): Promise<JiraSite[]> {
  const list = await liveRequest<Array<{ id?: string; url?: string; name?: string; scopes?: string[] }>>(
    { provider: PROVIDER, url: `${ATLASSIAN_API}/oauth/token/accessible-resources`, auth, classify: jiraClassify },
    deps,
  );
  return (Array.isArray(list) ? list : [])
    .filter((r) => r.id && (!Array.isArray(r.scopes) || r.scopes.some((s) => /jira/.test(s))))
    .map((r) => ({ cloudId: String(r.id), url: String(r.url ?? ""), name: String(r.name ?? "") }));
}

const CLOUD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pick the site: configured cloud id / site URL, else the first Jira site. */
export async function resolveJiraSite(
  auth: TokenSource,
  projectConfig: Record<string, unknown> | undefined,
  deps: LiveDeps = {},
): Promise<JiraSite> {
  const sites = await jiraAccessibleSites(auth, deps);
  if (sites.length === 0) {
    throw new ConnectorApiError(PROVIDER, "forbidden", "This Jira sign-in cannot reach any Jira site — reconnect and pick a site on the consent screen.");
  }
  const wantId = typeof projectConfig?.cloudId === "string" ? projectConfig.cloudId.trim() : "";
  const wantSite = typeof projectConfig?.site === "string" ? projectConfig.site.trim().replace(/\/+$/, "").toLowerCase() : "";
  if (wantId || wantSite) {
    const hit = sites.find((s) => (wantId && s.cloudId === wantId) || (wantSite && s.url.replace(/\/+$/, "").toLowerCase() === wantSite));
    if (!hit) {
      throw new ConnectorApiError(PROVIDER, "not_found", `The configured Jira site is not in this sign-in (available: ${sites.map((s) => s.url).join(", ")}).`);
    }
    return hit;
  }
  return sites[0];
}

function base(site: JiraSite): string {
  if (!CLOUD_ID_RE.test(site.cloudId)) throw new ConnectorApiError(PROVIDER, "provider_error", "Jira returned an unexpected site id.");
  return `${ATLASSIAN_API}/ex/jira/${site.cloudId}/rest/api/3`;
}

// --------------------------------------------------------------- input checks

const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]{1,9}$/;
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]{1,9}-\d{1,9}$/;

export function projectKeyOf(v: unknown): string {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  if (!s) throw new Error("projectKey is required.");
  if (!PROJECT_KEY_RE.test(s)) throw new Error('projectKey must be a Jira project key like "OPS".');
  return s;
}

export function issueKeyOf(v: unknown): string {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  if (!s) throw new Error("issueKey is required.");
  if (!ISSUE_KEY_RE.test(s) && !/^\d{1,12}$/.test(s)) throw new Error('issueKey must be a Jira issue key like "OPS-12".');
  return s;
}

/** Plain text → Atlassian Document Format (one paragraph per blank-line block). PURE. */
export function textToAdf(text: string): Record<string, unknown> {
  const paras = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    type: "doc",
    version: 1,
    content: paras.map((p) => {
      const lines = p.split("\n");
      const content: Array<Record<string, unknown>> = [];
      lines.forEach((line, i) => {
        if (i > 0) content.push({ type: "hardBreak" });
        if (line) content.push({ type: "text", text: line });
      });
      return { type: "paragraph", content };
    }),
  };
}

/** ADF → plain text (best effort, for reading descriptions). PURE. */
export function adfToText(node: unknown, max = 4000): string {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    const o = n as { type?: string; text?: string; content?: unknown[] };
    if (o.type === "text" && typeof o.text === "string") out.push(o.text);
    if (o.type === "hardBreak") out.push("\n");
    if (Array.isArray(o.content)) for (const c of o.content) walk(c);
    if (o.type === "paragraph" || o.type === "heading" || o.type === "listItem") out.push("\n");
  };
  walk(node);
  return out.join("").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}

function text(v: unknown, field: string, max: number, required = true): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s && required) throw new Error(`${field} is required.`);
  return s.slice(0, max);
}

// --------------------------------------------------------------- shapes

export interface JiraIssue {
  id: string;
  key: string;
  summary: string;
  status: string | null;
  statusCategory: string | null;
  issueType: string | null;
  priority: string | null;
  assignee: string | null;
  updated: string | null;
  url: string;
}

interface RawIssue {
  id?: string;
  key?: string;
  fields?: {
    summary?: string;
    status?: { name?: string; statusCategory?: { key?: string } };
    issuetype?: { name?: string };
    priority?: { name?: string } | null;
    assignee?: { displayName?: string } | null;
    updated?: string;
    description?: unknown;
  };
}

const ISSUE_FIELDS = "summary,status,issuetype,priority,assignee,updated";

const toIssue = (site: JiraSite, i: RawIssue): JiraIssue => ({
  id: String(i.id ?? ""),
  key: String(i.key ?? ""),
  summary: String(i.fields?.summary ?? "").slice(0, 500),
  status: i.fields?.status?.name ?? null,
  statusCategory: i.fields?.status?.statusCategory?.key ?? null,
  issueType: i.fields?.issuetype?.name ?? null,
  priority: i.fields?.priority?.name ?? null,
  assignee: i.fields?.assignee?.displayName ?? null,
  updated: i.fields?.updated ?? null,
  url: `${site.url.replace(/\/+$/, "")}/browse/${String(i.key ?? "")}`,
});

// --------------------------------------------------------------- reads

export async function jiraListProjects(
  auth: TokenSource,
  site: JiraSite,
  opts: { limit?: unknown; query?: unknown } = {},
  deps: LiveDeps = {},
): Promise<Array<{ id: string; key: string; name: string; type: string | null }>> {
  const limit = clampInt(opts.limit, 50, 1, 200);
  const out: Array<{ id: string; key: string; name: string; type: string | null }> = [];
  let startAt = 0;
  for (;;) {
    const page = await liveRequest<{ values?: Array<{ id?: string; key?: string; name?: string; projectTypeKey?: string }>; isLast?: boolean }>(
      {
        provider: PROVIDER,
        url: `${base(site)}/project/search`,
        query: { startAt, maxResults: Math.min(50, limit - out.length), orderBy: "name", query: typeof opts.query === "string" ? opts.query.slice(0, 100) : undefined },
        auth,
        classify: jiraClassify,
      },
      deps,
    );
    const values = page?.values ?? [];
    for (const p of values) out.push({ id: String(p.id ?? ""), key: String(p.key ?? ""), name: String(p.name ?? ""), type: p.projectTypeKey ?? null });
    if (page?.isLast !== false || values.length === 0 || out.length >= limit) break;
    startAt += values.length;
  }
  return out.slice(0, limit);
}

/**
 * JQL search (enhanced endpoint, token pagination). Either `jql` or a
 * `projectKey` (→ project = KEY ORDER BY updated DESC). Bounded JQL — the
 * search endpoint rejects unbounded queries.
 */
export async function jiraSearchIssues(
  auth: TokenSource,
  site: JiraSite,
  opts: { jql?: unknown; projectKey?: unknown; limit?: unknown; pageToken?: unknown },
  deps: LiveDeps = {},
): Promise<{ issues: JiraIssue[]; nextPageToken: string | null }> {
  let jql = text(opts.jql, "jql", 2000, false);
  if (!jql) {
    if (opts.projectKey === undefined || opts.projectKey === null || opts.projectKey === "") throw new Error("jql or projectKey is required.");
    jql = `project = "${projectKeyOf(opts.projectKey)}" ORDER BY updated DESC`;
  }
  const limit = clampInt(opts.limit, 25, 1, 200);
  const issues: JiraIssue[] = [];
  let token: string | null = typeof opts.pageToken === "string" && opts.pageToken.trim() ? opts.pageToken.trim().slice(0, 2000) : null;
  for (;;) {
    const page = await liveRequest<{ issues?: RawIssue[]; nextPageToken?: string; isLast?: boolean }>(
      {
        provider: PROVIDER,
        url: `${base(site)}/search/jql`,
        query: { jql, maxResults: Math.min(100, limit - issues.length), fields: ISSUE_FIELDS, nextPageToken: token },
        auth,
        classify: jiraClassify,
      },
      deps,
    );
    for (const i of page?.issues ?? []) issues.push(toIssue(site, i));
    token = page?.nextPageToken && page.isLast !== true ? page.nextPageToken : null;
    if (!token || issues.length >= limit || (page?.issues ?? []).length === 0) break;
  }
  return { issues: issues.slice(0, limit), nextPageToken: token };
}

export async function jiraGetIssue(
  auth: TokenSource,
  site: JiraSite,
  issueKey: unknown,
  deps: LiveDeps = {},
): Promise<JiraIssue & { description: string }> {
  const key = issueKeyOf(issueKey);
  const raw = await liveRequest<RawIssue>(
    { provider: PROVIDER, url: `${base(site)}/issue/${encodeURIComponent(key)}`, query: { fields: `${ISSUE_FIELDS},description` }, auth, classify: jiraClassify },
    deps,
  );
  return { ...toIssue(site, raw ?? {}), description: adfToText(raw?.fields?.description) };
}

// --------------------------------------------------------------- writes (never retried)

export async function jiraCreateIssue(
  auth: TokenSource,
  site: JiraSite,
  opts: { projectKey?: unknown; summary?: unknown; issueType?: unknown; description?: unknown; priority?: unknown; labels?: unknown },
  deps: LiveDeps = {},
): Promise<{ id: string; key: string; url: string }> {
  const fields: Record<string, unknown> = {
    project: { key: projectKeyOf(opts.projectKey) },
    summary: text(opts.summary, "summary", 255).replace(/[\r\n]+/g, " "),
    issuetype: { name: text(opts.issueType, "issueType", 60, false) || "Task" },
  };
  const description = text(opts.description, "description", 30_000, false);
  if (description) fields.description = textToAdf(description);
  const priority = text(opts.priority, "priority", 60, false);
  if (priority) fields.priority = { name: priority };
  if (typeof opts.labels === "string" && opts.labels.trim()) {
    fields.labels = opts.labels
      .split(",")
      .map((l) => l.trim().replace(/\s+/g, "-"))
      .filter(Boolean)
      .slice(0, 20);
  }
  const res = await liveRequest<{ id?: string; key?: string }>(
    { provider: PROVIDER, url: `${base(site)}/issue`, method: "POST", json: { fields }, auth, classify: jiraClassify },
    writeDeps(deps),
  );
  if (!res?.key) throw new ConnectorApiError(PROVIDER, "provider_error", "Jira did not return the new issue key.");
  return { id: String(res.id ?? ""), key: res.key, url: `${site.url.replace(/\/+$/, "")}/browse/${res.key}` };
}

export async function jiraListTransitions(
  auth: TokenSource,
  site: JiraSite,
  issueKey: string,
  deps: LiveDeps = {},
): Promise<Array<{ id: string; name: string; to: string | null }>> {
  const res = await liveRequest<{ transitions?: Array<{ id?: string; name?: string; to?: { name?: string } }> }>(
    { provider: PROVIDER, url: `${base(site)}/issue/${encodeURIComponent(issueKey)}/transitions`, auth, classify: jiraClassify },
    deps,
  );
  return (res?.transitions ?? []).map((t) => ({ id: String(t.id ?? ""), name: String(t.name ?? ""), to: t.to?.name ?? null }));
}

/**
 * Move an issue through its workflow. `transition` is a transition id, a
 * transition name ("Start progress") or a target status ("Done").
 */
export async function jiraTransitionIssue(
  auth: TokenSource,
  site: JiraSite,
  opts: { issueKey?: unknown; transition?: unknown; comment?: unknown },
  deps: LiveDeps = {},
): Promise<{ key: string; transitioned: true; to: string | null }> {
  const key = issueKeyOf(opts.issueKey);
  const want = text(opts.transition, "transition", 100).toLowerCase();
  const available = await jiraListTransitions(auth, site, key, deps);
  const hit =
    available.find((t) => t.id === want) ??
    available.find((t) => t.name.toLowerCase() === want) ??
    available.find((t) => (t.to ?? "").toLowerCase() === want);
  if (!hit) {
    throw new Error(`transition must be one of: ${available.map((t) => `${t.name}${t.to ? ` (→ ${t.to})` : ""}`).join(", ") || "(none available)"}.`);
  }
  const body: Record<string, unknown> = { transition: { id: hit.id } };
  const comment = text(opts.comment, "comment", 30_000, false);
  if (comment) body.update = { comment: [{ add: { body: textToAdf(comment) } }] };
  await liveRequest(
    { provider: PROVIDER, url: `${base(site)}/issue/${encodeURIComponent(key)}/transitions`, method: "POST", json: body, auth, classify: jiraClassify },
    writeDeps(deps),
  );
  return { key, transitioned: true, to: hit.to };
}

export async function jiraAddComment(
  auth: TokenSource,
  site: JiraSite,
  opts: { issueKey?: unknown; body?: unknown },
  deps: LiveDeps = {},
): Promise<{ id: string; key: string }> {
  const key = issueKeyOf(opts.issueKey);
  const body = text(opts.body, "body", 30_000);
  const res = await liveRequest<{ id?: string }>(
    { provider: PROVIDER, url: `${base(site)}/issue/${encodeURIComponent(key)}/comment`, method: "POST", json: { body: textToAdf(body) }, auth, classify: jiraClassify },
    writeDeps(deps),
  );
  return { id: String(res?.id ?? ""), key };
}
