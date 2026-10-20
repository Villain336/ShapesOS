// ShapesOS — Phase 1 (H3) guard: RLS is never the ONLY tenant boundary.
//
// RLS policies are bypassed by a superuser / BYPASSRLS connection (the old
// compose default), so every Prisma query that runs inside a workspace scope
// (withWorkspaceScope / withCampaignScope / a raw `app.workspace_id` GUC) must
// ALSO carry `workspaceId` in its `where`. This test statically scans lib/ and
// app/ and fails on any by-id / list query on a workspace-owned model whose
// `where` has no workspaceId.
// Run: npx tsx --test lib/substrate/memory/__tests__/rls-defense-in-depth.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..", "..", "..");

/** Reviewed exceptions: `file:model.op` → why it is safe. */
const ALLOW = new Map<string, string>([
  ["lib/intelligence/gsc/window-score.ts:gscSnapshot.findMany", "projectId-scoped tx helper; callers resolve the project inside the workspace"],
  ["lib/intelligence/gsc/deltas.ts:gscSnapshot.findMany", "projectId-scoped tx helper; callers resolve the project inside the workspace"],
  ["app/api/cron/fleet/route.ts:competitorWatch.findMany", "cron-only fan-out that lists workspaces, outside any scope"],
  // Phase 9 (repos): GitHub delivery routing / poller discovery — the one cross-workspace read, through the SELECT-only app.github_route policy; returns ids only, every write is tenant-scoped.
  ["lib/ship/pr-routing.ts:agentPullRequest.findFirst", "routePullRequest: maps (repository, branch | PR) to its workspace via the SELECT-only app.github_route policy"],
  ["lib/ship/pr-routing.ts:agentPullRequest.findMany", "discoverOpenPullRequests: poller fan-out across workspaces via the SELECT-only app.github_route policy (ids only)"],
  // Phase 10 (store): public storefront routing — slug → workspace, the one cross-workspace read, through the SELECT-only app.store_route policy (published stores only); everything after it is tenant-scoped.
  ["lib/ops/store/catalog.ts:opsStore.findFirst", "resolvePublishedStore: maps a public /shop/<slug> to its workspace via the SELECT-only app.store_route policy (published rows only)"],
  // Phase 11 (conncore): Slack Events API routing — team_id → workspace, the one cross-workspace read, through the SELECT-only app.slack_route policy; every write after it is tenant-scoped.
  ["lib/slack/install.ts:slackInstallation.findFirst", "routeSlackTeam: maps a signed Slack event's team_id to its workspace via the SELECT-only app.slack_route policy"],
  // Phase 10 (portal): the sign-in request names no workspace — the address may be a client of several; clients is not a tenant (RLS) table. Ids + workspace name only; every link write that follows is tenant-scoped.
  // Phase 12 (people): public event routing — /events/<slug> → workspace, the one cross-workspace read, through the SELECT-only app.event_route policy (published events only); everything after it is tenant-scoped.
  ["lib/ops/events/catalog.ts:opsEvent.findFirst", "resolvePublishedEvent: maps a public /events/<slug> to its workspace via the SELECT-only app.event_route policy (published rows only)"],
  // Phase 18.2 (comms): the project team chat now runs under withWorkspaceScope; its project lookup comes first and resolves the workspace from the caller's own memberships.
  ["app/api/team/chat/route.ts:project.findFirst", "projectAccess: resolves the project through accessibleWorkspaceWhere(userId) (the caller's memberships) before any workspace is known; every chat query after it is workspace-scoped"],
  // Phase 18.2 (content): public file share links — token hash → link, the one cross-workspace read, through the SELECT-only app.file_share_route policy (live links only); everything after it runs under the link's workspace scope.
  ["lib/files/shares.ts:workspaceFileShare.findFirst", "resolveShareToken: maps a public /r/file/<token> to its link via the SELECT-only app.file_share_route policy (unrevoked rows only)"],
  // Phase 18.3 (WS=flow): the hourly Time Machine sweep lists which workspaces asked for scheduled snapshots (workspace_settings is not a tenant RLS table; ids + schedule only); every snapshot read / write after it runs under that workspace's scope.
  ["lib/timemachine/snapshots.ts:workspaceSettings.findMany", "runDueSnapshots: cron-only fan-out over workspaces with a snapshot schedule (ids only); each snapshot is taken under its own workspace scope"],
  // Phase 21B (WS=drive): the scheduled trash sweep lists expired files across workspaces (the same cron-only fan-out it always was; the file service is now scanned because it enters workspace scope); each purge runs under that file's own workspace scope.
  ["lib/filesystem/service.ts:workspaceFile.findMany", "purgeExpiredTrash: cron-only fan-out over files past the trash retention; each purge is workspace-scoped"],
  ["lib/portal/store.ts:client.findMany", "requestPortalLink: finds the portal-enabled clients with this sign-in email across workspaces (no workspace in the request); returns ids only, each link row is written under that client's own workspace scope"],
]);

const SCOPE_MARKERS = ["withWorkspaceScope", "withWorkspace(", "withCampaignScope", "setWorkspaceGuc", "app.workspace_id"];
const OPS = "findUnique|findFirst|findUniqueOrThrow|findFirstOrThrow|update|updateMany|delete|deleteMany|upsert|count|findMany|aggregate|groupBy";
const LIST_OPS = new Set(["findMany", "count", "aggregate", "groupBy", "deleteMany", "updateMany"]);

function workspaceModels(): Set<string> {
  const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
  const out = new Set<string>();
  for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    if (/^\s+workspaceId\s/m.test(m[2]!)) out.add(m[1]![0]!.toLowerCase() + m[1]!.slice(1));
  }
  return out;
}

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* sourceFiles(p);
    else if (/\.tsx?$/.test(name) && !name.includes(".test.")) yield p;
  }
}

function balanced(s: string, i: number): string {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "{") depth++;
    else if (s[j] === "}" && --depth === 0) return s.slice(i, j + 1);
  }
  return s.slice(i);
}

export function findUnscopedQueries(): string[] {
  const models = workspaceModels();
  const call = new RegExp(`\\.(\\w+)\\.(${OPS})\\(`, "g");
  const hits: string[] = [];
  for (const base of ["lib", "app"]) {
    for (const file of sourceFiles(join(ROOT, base))) {
      const src = readFileSync(file, "utf8");
      if (!SCOPE_MARKERS.some((k) => src.includes(k))) continue;
      const rel = relative(ROOT, file);
      for (const m of src.matchAll(call)) {
        const [, model, op] = m;
        if (!models.has(model!)) continue;
        if (ALLOW.has(`${rel}:${model}.${op}`)) continue;
        const seg = src.slice(m.index! + m[0].length, m.index! + m[0].length + 600);
        const w = seg.indexOf("where");
        const line = src.slice(0, m.index).split("\n").length;
        if (w < 0 || w > 200) {
          if (LIST_OPS.has(op!)) hits.push(`${rel}:${line} ${model}.${op} (no where)`);
          continue;
        }
        const b = seg.indexOf("{", w);
        if (b < 0) continue;
        const where = balanced(seg, b);
        if (!where.includes("workspaceId")) hits.push(`${rel}:${line} ${model}.${op} ${where.replace(/\s+/g, " ").slice(0, 80)}`);
      }
    }
  }
  return hits;
}

describe("RLS defense in depth (H3)", () => {
  it("every workspace-scoped Prisma query also filters by workspaceId", () => {
    const hits = findUnscopedQueries();
    assert.deepEqual(hits, [], `queries relying on RLS alone:\n${hits.join("\n")}`);
  });
});
