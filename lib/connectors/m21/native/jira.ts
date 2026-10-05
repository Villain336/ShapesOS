// ShapesOS — Phase 11 (devtools): Jira Cloud adapter (native).
//
// LIVE WIRING: Atlassian OAuth 2.0 (3LO; scopes read:jira-work
// write:jira-work read:jira-user offline_access) → the vault credential; the
// site (cloud id) comes from accessible-resources, or the project data
// source's projectConfig.cloudId / .site. Tools call Jira REST v3
// (lib/connectors/m21/live/jira.ts):
//   list_projects     project/search
//   search_issues     search/jql (JQL, or a project key)
//   get_issue         issue/{key}
//   create_issue      POST issue                      [mutating]
//   transition_issue  POST issue/{key}/transitions    [mutating]
//   add_comment       POST issue/{key}/comment        [mutating]
// Tool group "ops"; writes map to the Tier-2 "write_project_record" action
// (always ask). Writes are never retried.
//
// MOCK MODE (no credential; dev/test/demo only — production answers "not
// connected"): labelled "(MOCK)" rows; mock writes write nothing.

import type {
  ConnectorAdapter,
  ConnectorToolDef,
  DecryptedCredential,
  InvokeContext,
  InvokeResult,
} from "../types";
import { fail, liveOk, mockOk, numProp, strProp } from "../types";
import { liveFailure, tokenSourceFrom, type LiveDeps } from "../live/http";
import { stickyAuth } from "../live/sticky-auth";
import {
  jiraAccessibleSites,
  jiraAddComment,
  jiraCreateIssue,
  jiraGetIssue,
  jiraListProjects,
  jiraSearchIssues,
  jiraTransitionIssue,
  resolveJiraSite,
} from "../live/jira";
import { inputFailure } from "./outlook";

export class JiraAdapter implements ConnectorAdapter {
  readonly key = "jira";
  readonly displayName = "Jira";
  readonly authType = "oauth2" as const;
  readonly configSchema = {
    type: "object",
    properties: {
      cloudId: { type: "string", description: "Jira site cloud id (optional; default: the first site the sign-in can reach)." },
      site: { type: "string", description: "Jira site URL, e.g. https://acme.atlassian.net (alternative to cloudId)." },
    },
  };

  constructor(private readonly deps: LiveDeps = {}) {}

  listTools(): ConnectorToolDef[] {
    return [
      {
        name: "list_projects",
        description: "List Jira projects on the connected site (key, name, type).",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: { query: strProp("Filter by name or key (optional)."), limit: numProp("Max projects (default 50, max 200).") },
        },
      },
      {
        name: "search_issues",
        description: "Find Jira issues with a JQL query, or list a project's issues by key (most recently updated first).",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: {
            jql: strProp('JQL, e.g. project = OPS AND status != Done ORDER BY updated DESC (optional when projectKey is given).'),
            projectKey: strProp('Project key like "OPS" (used when jql is empty).'),
            limit: numProp("Max issues (default 25, max 200)."),
            pageToken: strProp("nextPageToken from a previous call, to continue."),
          },
        },
      },
      {
        name: "get_issue",
        description: "Read one Jira issue (status, assignee, description as text).",
        mutating: false,
        argsSchema: { type: "object", properties: { issueKey: strProp('Issue key like "OPS-12".') }, required: ["issueKey"] },
      },
      {
        name: "create_issue",
        description: "Create a Jira issue in a project. Asks for confirmation first.",
        mutating: true,
        argsSchema: {
          type: "object",
          properties: {
            projectKey: strProp('Project key like "OPS".'),
            summary: strProp("Issue summary (one line)."),
            issueType: strProp('Issue type name (default "Task").'),
            description: strProp("Description (plain text), optional."),
            priority: strProp('Priority name, e.g. "High" (optional).'),
            labels: strProp("Comma-separated labels (optional)."),
          },
          required: ["projectKey", "summary"],
        },
      },
      {
        name: "transition_issue",
        description: "Move a Jira issue through its workflow (e.g. to In Progress or Done). Asks for confirmation first.",
        mutating: true,
        argsSchema: {
          type: "object",
          properties: {
            issueKey: strProp('Issue key like "OPS-12".'),
            transition: strProp('Transition name, target status (e.g. "Done") or transition id.'),
            comment: strProp("Comment to add with the transition (optional)."),
          },
          required: ["issueKey", "transition"],
        },
      },
      {
        name: "add_comment",
        description: "Comment on a Jira issue. Asks for confirmation first.",
        mutating: true,
        argsSchema: {
          type: "object",
          properties: { issueKey: strProp('Issue key like "OPS-12".'), body: strProp("Comment text.") },
          required: ["issueKey", "body"],
        },
      },
    ];
  }

  async invoke(
    tool: string,
    args: Record<string, unknown>,
    credential: DecryptedCredential | null,
    ctx: InvokeContext,
  ): Promise<InvokeResult> {
    const source = tokenSourceFrom(credential, ctx);
    if (!source) return this.mock(tool, args);
    if (!this.listTools().some((t) => t.name === tool)) return fail(`Unknown tool "${tool}" for connector ${this.key}`);
    // The site lookup and the call are separate requests: keep a refreshed token.
    const auth = stickyAuth(source);
    try {
      const site = await resolveJiraSite(auth, ctx.projectConfig, this.deps);
      switch (tool) {
        case "list_projects":
          return liveOk({ site: site.url, projects: await jiraListProjects(auth, site, { limit: args.limit, query: args.query }, this.deps) });
        case "search_issues":
          return liveOk(await jiraSearchIssues(auth, site, { jql: args.jql, projectKey: args.projectKey, limit: args.limit, pageToken: args.pageToken }, this.deps));
        case "get_issue":
          return liveOk(await jiraGetIssue(auth, site, args.issueKey, this.deps));
        case "create_issue":
          return liveOk(await jiraCreateIssue(auth, site, args, this.deps));
        case "transition_issue":
          return liveOk(await jiraTransitionIssue(auth, site, { issueKey: args.issueKey, transition: args.transition, comment: args.comment }, this.deps));
        case "add_comment":
          return liveOk(await jiraAddComment(auth, site, { issueKey: args.issueKey, body: args.body }, this.deps));
        default:
          return fail(`Unknown tool "${tool}" for connector ${this.key}`);
      }
    } catch (err) {
      return inputFailure(err, "Jira");
    }
  }

  async healthCheck(credential: DecryptedCredential, ctx: InvokeContext): Promise<InvokeResult> {
    const auth = tokenSourceFrom(credential, ctx);
    if (!auth) return { ok: false, errorCode: "not_connected", error: "Jira is not connected." };
    try {
      const sites = await jiraAccessibleSites(auth, this.deps);
      if (sites.length === 0) return { ok: false, mock: false, errorCode: "forbidden", error: "This Jira sign-in cannot reach any Jira site." };
      return liveOk({ sites: sites.map((s) => s.url) });
    } catch (err) {
      return liveFailure(err, "Jira");
    }
  }

  /** Labelled mock (dev/test/demo). Writes nothing. */
  private mock(tool: string, args: Record<string, unknown>): InvokeResult {
    const issue = { id: "10001", key: "OPS-1", summary: "Renew the SSL certificate (MOCK)", status: "To Do", statusCategory: "new", issueType: "Task", priority: "Medium", assignee: null, updated: "2026-10-01T00:00:00.000+0000", url: "https://example.atlassian.net/browse/OPS-1", mock: true };
    switch (tool) {
      case "list_projects":
        return mockOk({ site: "https://example.atlassian.net", projects: [{ id: "10000", key: "OPS", name: "Operations (MOCK)", type: "software", mock: true }] });
      case "search_issues":
        return mockOk({ issues: [issue], nextPageToken: null });
      case "get_issue":
        return mockOk({ ...issue, description: "Expires next week. (MOCK)" });
      case "create_issue":
      case "transition_issue":
      case "add_comment":
        return mockOk({ written: false, mock: true, issueKey: String(args.issueKey ?? ""), info: "MOCK — Jira is not connected; nothing was written." });
      default:
        return fail(`Unknown tool "${tool}" for connector ${this.key}`);
    }
  }
}
