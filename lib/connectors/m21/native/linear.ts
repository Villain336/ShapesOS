// ShapesOS — Phase 11 (devtools): Linear adapter (native).
//
// LIVE WIRING: Linear OAuth2 (scopes read,write) → the vault credential;
// every tool calls the Linear GraphQL API (lib/connectors/m21/live/linear.ts):
//   list_teams      teams
//   list_projects   projects
//   list_issues     issues (team / state-type filter, cursor pagination)
//   search_issues   searchIssues
//   create_issue    issueCreate     [mutating]
//   update_issue    issueUpdate     [mutating]
//   add_comment     commentCreate   [mutating]
// Tool group: "ops" (projects and tasks are business operations — the "code"
// group is the sandbox runner and is unavailable without one). Mutating tools
// map to the Tier-2 "write_project_record" action: they always ask
// (lib/agents/grants.ts connectorAction). Writes are never retried.
//
// MOCK MODE (no credential; dev/test/demo only — production answers "not
// connected", lib/connectors/m21/no-fakes.ts): labelled "(MOCK)" rows; mock
// writes write nothing. No network calls.

import type {
  ConnectorAdapter,
  ConnectorToolDef,
  DecryptedCredential,
  InvokeContext,
  InvokeResult,
} from "../types";
import { fail, liveOk, mockOk, numProp, strProp } from "../types";
import { liveFailure, tokenSourceFrom, type LiveDeps } from "../live/http";
import {
  linearAddComment,
  linearCreateIssue,
  linearListIssues,
  linearListProjects,
  linearListTeams,
  linearSearchIssues,
  linearUpdateIssue,
  linearViewer,
} from "../live/linear";
import { stickyAuth } from "../live/sticky-auth";
import { inputFailure } from "./outlook";

export class LinearAdapter implements ConnectorAdapter {
  readonly key = "linear";
  readonly displayName = "Linear";
  readonly authType = "oauth2" as const;
  readonly configSchema = { type: "object", properties: {} };

  constructor(private readonly deps: LiveDeps = {}) {}

  listTools(): ConnectorToolDef[] {
    return [
      {
        name: "list_teams",
        description: "List the Linear teams in the connected workspace (id, key, name).",
        mutating: false,
        argsSchema: { type: "object", properties: {} },
      },
      {
        name: "list_projects",
        description: "List Linear projects (name, state, progress, target date).",
        mutating: false,
        argsSchema: { type: "object", properties: { limit: numProp("Max projects (default 50, max 100).") } },
      },
      {
        name: "list_issues",
        description: "List Linear issues, most recently updated first, optionally for one team and/or state type.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: {
            teamId: strProp("Team id (from list_teams), optional."),
            stateType: strProp('State type filter: "triage", "backlog", "unstarted", "started", "completed" or "canceled".'),
            limit: numProp("Max issues (default 25, max 250)."),
            cursor: strProp("nextCursor from a previous call, to continue."),
          },
        },
      },
      {
        name: "search_issues",
        description: "Search Linear issues by text (title, description, comments).",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: { query: strProp("Search text."), limit: numProp("Max issues (default 25, max 50).") },
          required: ["query"],
        },
      },
      {
        name: "create_issue",
        description: "Create a Linear issue in a team. Asks for confirmation first.",
        mutating: true,
        argsSchema: {
          type: "object",
          properties: {
            teamId: strProp("Team id (from list_teams)."),
            title: strProp("Issue title."),
            description: strProp("Issue description (Markdown), optional."),
            priority: numProp("0 none, 1 urgent, 2 high, 3 medium, 4 low (optional)."),
            assigneeId: strProp("User id to assign (optional)."),
            projectId: strProp("Project id (optional)."),
            stateId: strProp("Workflow state id (optional)."),
          },
          required: ["teamId", "title"],
        },
      },
      {
        name: "update_issue",
        description: "Change a Linear issue's title, description, priority, assignee, state or project. Asks for confirmation first.",
        mutating: true,
        argsSchema: {
          type: "object",
          properties: {
            issueId: strProp('Issue id or key like "ENG-123".'),
            title: strProp("New title (optional)."),
            description: strProp("New description (optional)."),
            priority: numProp("0 none, 1 urgent, 2 high, 3 medium, 4 low (optional)."),
            assigneeId: strProp("User id to assign (optional)."),
            stateId: strProp("Workflow state id to move it to (optional)."),
            projectId: strProp("Project id (optional)."),
          },
          required: ["issueId"],
        },
      },
      {
        name: "add_comment",
        description: "Comment on a Linear issue. Asks for confirmation first.",
        mutating: true,
        argsSchema: {
          type: "object",
          properties: { issueId: strProp('Issue id or key like "ENG-123".'), body: strProp("Comment text (Markdown).") },
          required: ["issueId", "body"],
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
    // Pagination makes several requests: keep a refreshed token for the rest.
    const auth = stickyAuth(source);
    try {
      switch (tool) {
        case "list_teams":
          return liveOk(await linearListTeams(auth, this.deps));
        case "list_projects":
          return liveOk(await linearListProjects(auth, { limit: args.limit }, this.deps));
        case "list_issues":
          return liveOk(await linearListIssues(auth, { teamId: args.teamId, stateType: args.stateType, limit: args.limit, cursor: args.cursor }, this.deps));
        case "search_issues":
          return liveOk(await linearSearchIssues(auth, { query: args.query, limit: args.limit }, this.deps));
        case "create_issue":
          return liveOk(await linearCreateIssue(auth, args, this.deps));
        case "update_issue":
          return liveOk(await linearUpdateIssue(auth, args, this.deps));
        case "add_comment":
          return liveOk(await linearAddComment(auth, { issueId: args.issueId, body: args.body }, this.deps));
        default:
          return fail(`Unknown tool "${tool}" for connector ${this.key}`);
      }
    } catch (err) {
      return inputFailure(err, "Linear");
    }
  }

  async healthCheck(credential: DecryptedCredential, ctx: InvokeContext): Promise<InvokeResult> {
    const auth = tokenSourceFrom(credential, ctx);
    if (!auth) return { ok: false, errorCode: "not_connected", error: "Linear is not connected." };
    try {
      return liveOk(await linearViewer(auth, this.deps));
    } catch (err) {
      return liveFailure(err, "Linear");
    }
  }

  /** Labelled mock (dev/test/demo). Writes nothing. */
  private mock(tool: string, args: Record<string, unknown>): InvokeResult {
    const issue = { id: "mock-issue-1", identifier: "ENG-1", title: "Fix the signup form (MOCK)", priority: 2, state: "Todo", stateType: "unstarted", assignee: null, team: "ENG", project: null, url: null, updatedAt: "2026-10-01T00:00:00Z", mock: true };
    switch (tool) {
      case "list_teams":
        return mockOk([{ id: "mock-team-1", key: "ENG", name: "Engineering (MOCK)", mock: true }]);
      case "list_projects":
        return mockOk([{ id: "mock-project-1", name: "Website relaunch (MOCK)", state: "started", progress: 0.4, targetDate: null, url: null, mock: true }]);
      case "list_issues":
        return mockOk({ issues: [issue], nextCursor: null });
      case "search_issues":
        return mockOk([issue]);
      case "create_issue":
      case "update_issue":
      case "add_comment":
        return mockOk({ written: false, mock: true, issueId: String(args.issueId ?? ""), info: "MOCK — Linear is not connected; nothing was written." });
      default:
        return fail(`Unknown tool "${tool}" for connector ${this.key}`);
    }
  }
}
