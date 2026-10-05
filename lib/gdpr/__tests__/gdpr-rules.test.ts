// ShapesOS — Phase 4a GDPR rules, no database: column classification,
// workspace scoping over a synthetic catalog, the account-deletion plan,
// typed confirmation, export slots and the self-service guard.
// Run: npx tsx --test lib/gdpr/__tests__/gdpr-rules.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  exportableColumns,
  isSecretColumn,
  isUserRefColumn,
  workspaceScopePredicate,
  type Catalog,
  type TableInfo,
} from "../catalog";
import { exportFilename, planWorkspaceExport } from "../workspace-export";
import { userPredicate, userRefTables } from "../user-export";
import {
  DELETE_ACCOUNT_PHRASE,
  accountConfirmationMatches,
  accountConfirmationText,
  blockerMessage,
  planAccountDeletion,
  pseudonymizeTargets,
  type WorkspaceFacts,
} from "../account-delete";
import { claimExportSlot, releaseExportSlot, releasingStream } from "../limit";
import { requireSelfService } from "../../auth/require-self-service";

function table(name: string, cols: [string, string][], extra: Partial<TableInfo> = {}): TableInfo {
  return {
    name,
    columns: cols.map(([n, type]) => ({ name: n, type })),
    primaryKey: ["id"],
    foreignKeys: [],
    hasWorkspaceId: cols.some(([n]) => n === "workspace_id"),
    rls: false,
    hashChained: cols.some(([n]) => n === "event_hash"),
    hasTriggers: false,
    ...extra,
  };
}

const catalog: Catalog = new Map(
  [
    table("workspaces", [["id", "text"], ["name", "text"], ["owner_user_id", "text"]]),
    table("projects", [["id", "text"], ["workspace_id", "text"], ["domain", "text"]]),
    table("pages", [["id", "text"], ["project_id", "text"], ["created_by", "text"]], {
      foreignKeys: [{ column: "project_id", refTable: "projects", refColumn: "id" }],
    }),
    table("page_revisions", [["id", "text"], ["page_id", "text"], ["body", "text"]], {
      foreignKeys: [{ column: "page_id", refTable: "pages", refColumn: "id" }],
    }),
    table("skills_catalog", [["id", "text"], ["name", "text"]]),
    table("connector_credentials", [["connection_id", "text"], ["encrypted_blob", "text"], ["key_version", "text"]], {
      primaryKey: ["connection_id"],
      foreignKeys: [{ column: "connection_id", refTable: "connections", refColumn: "id" }],
    }),
    table("connections", [["id", "text"], ["workspace_id", "text"], ["user_id", "text"]]),
    table("mcp_oauth_tokens", [["token_hash", "text"], ["workspace_id", "text"], ["user_id", "text"]]),
    table("mission_events", [["id", "text"], ["workspace_id", "text"], ["actor", "text"], ["event_hash", "text"]], { rls: true }),
    table("usage_events", [["id", "text"], ["workspace_id", "text"], ["actor_id", "text"]], { hasTriggers: true }),
    table("memory_facts", [["id", "text"], ["workspace_id", "text"], ["approved_by", "text"], ["embedding", "vector(1536)"]], { rls: true }),
    table("notifications", [["id", "text"], ["workspace_id", "text"], ["user_id", "text"]]),
  ].map((t) => [t.name, t]),
);

describe("column classification", () => {
  it("secret columns", () => {
    for (const c of ["encrypted_blob", "config_enc", "key_hash", "api_key_enc", "resend_key_hint", "secret_hint", "token", "invite_token", "webhook_secret_ref", "password", "signature_hash", "client_secret", "private_key"]) {
      assert.ok(isSecretColumn(c), c);
    }
    for (const c of ["id", "name", "summary", "fix_hint", "signature_status", "last_refresh_at", "content_hash", "workspace_id", "created_by"]) {
      assert.ok(!isSecretColumn(c), c);
    }
  });
  it("person-reference columns (text only)", () => {
    for (const c of ["user_id", "created_by", "approved_by", "actor", "actor_user_id", "owner_user_id", "decided_by"]) {
      assert.ok(isUserRefColumn(c, "text"), c);
    }
    assert.ok(!isUserRefColumn("created_by", "jsonb"));
    assert.ok(!isUserRefColumn("actor_kind", "text"));
    assert.ok(!isUserRefColumn("workspace_id", "text"));
  });
  it("exportable columns drop secrets and bulk types", () => {
    const { include, omitted } = exportableColumns(catalog.get("memory_facts")!);
    assert.deepEqual(include.map((c) => c.name), ["id", "workspace_id", "approved_by"]);
    assert.deepEqual(omitted, ["embedding"]);
  });
});

describe("workspace scope", () => {
  it("direct, indirect (one and two hops) and none", () => {
    assert.equal(workspaceScopePredicate(catalog, "projects"), `t."workspace_id" = $1`);
    assert.equal(
      workspaceScopePredicate(catalog, "pages"),
      `t."project_id" IN (SELECT t_1."id" FROM "projects" t_1 WHERE t_1."workspace_id" = $1)`,
    );
    const two = workspaceScopePredicate(catalog, "page_revisions")!;
    assert.match(two, /^t\."page_id" IN \(SELECT t_2\."id" FROM "pages" t_2 WHERE t_2\."project_id" IN \(SELECT t_2_p\."id" FROM "projects" t_2_p WHERE t_2_p\."workspace_id" = \$1\)\)$/);
    assert.equal(workspaceScopePredicate(catalog, "skills_catalog"), null);
    assert.equal(workspaceScopePredicate(catalog, "workspaces"), `t."id" = $1`);
  });

  it("the export plan covers owned tables, skips global ones and credential tables", () => {
    const { entries, omittedTables } = planWorkspaceExport(catalog);
    const names = entries.map((e) => e.table);
    for (const t of ["projects", "pages", "page_revisions", "connections", "connector_credentials", "mission_events", "memory_facts"]) {
      assert.ok(names.includes(t), t);
    }
    assert.ok(!names.includes("skills_catalog"));
    assert.ok(!names.includes("workspaces"), "emitted separately");
    assert.deepEqual(omittedTables, ["mcp_oauth_tokens"]);
    assert.deepEqual(entries.find((e) => e.table === "connector_credentials")!.omittedColumns, ["encrypted_blob"]);
  });

  it("user-reference tables and predicates", () => {
    const refs = userRefTables(catalog);
    assert.deepEqual(
      refs.map((r) => r.table),
      ["connections", "memory_facts", "mission_events", "notifications", "pages", "usage_events"],
    );
    assert.equal(userPredicate(["user_id", "created_by"], 2), `(t."user_id" = $2 OR t."created_by" = $2)`);
  });
});

describe("account deletion plan", () => {
  const ME = "me";
  const ws = (id: string, ownerUserId: string, members: [string, "owner" | "admin" | "editor" | "viewer"][], sub: WorkspaceFacts["subscription"] = null): WorkspaceFacts => ({
    id,
    name: `WS ${id}`,
    ownerUserId,
    members: members.map(([userId, role]) => ({ userId, role })),
    subscription: sub,
  });

  it("solo workspaces are deleted, shared ones left; ownership handed to another owner", () => {
    const plan = planAccountDeletion(ME, [
      ws("solo", ME, [[ME, "owner"]]),
      ws("coowned", ME, [[ME, "owner"], ["ana", "owner"], ["bo", "editor"]]),
      ws("member", "ana", [["ana", "owner"], [ME, "editor"]]),
    ]);
    assert.deepEqual(plan.blockers, []);
    assert.deepEqual(plan.deleteWorkspaces.map((w) => w.id), ["solo"]);
    assert.deepEqual(plan.leaveWorkspaces, [
      { id: "coowned", name: "WS coowned", newOwnerUserId: "ana" },
      { id: "member", name: "WS member", newOwnerUserId: null },
    ]);
  });

  it("blocks the sole owner of a workspace with members, and a solo workspace still paying", () => {
    const plan = planAccountDeletion(ME, [
      ws("team", ME, [[ME, "owner"], ["bo", "admin"]]),
      ws("legacy", ME, [["bo", "editor"]]), // owner by the workspace row only
      ws("paid", ME, [[ME, "owner"]], { status: "active", cancelAtPeriodEnd: false }),
      ws("ending", ME, [[ME, "owner"]], { status: "active", cancelAtPeriodEnd: true }),
    ]);
    assert.deepEqual(plan.blockers.map((b) => [b.workspaceId, b.reason]), [
      ["team", "sole_owner_with_members"],
      ["legacy", "sole_owner_with_members"],
      ["paid", "paid_subscription"],
    ]);
    assert.deepEqual(plan.deleteWorkspaces.map((w) => w.id), ["ending"]);
    const msg = blockerMessage(plan)!;
    assert.match(msg, /only owner of "WS team", "WS legacy", which have other members/);
    assert.match(msg, /"WS paid" still has a paid subscription/);
    assert.equal(blockerMessage(planAccountDeletion(ME, [])), null);
  });

  it("typed confirmation is the email (any case) or the phrase", () => {
    assert.equal(accountConfirmationText("Ana@Example.com"), "Ana@Example.com");
    assert.ok(accountConfirmationMatches(" ana@example.com ", "Ana@Example.com"));
    assert.ok(!accountConfirmationMatches("ana@example.co", "Ana@Example.com"));
    assert.equal(accountConfirmationText(null), DELETE_ACCOUNT_PHRASE);
    assert.ok(accountConfirmationMatches("Delete my account", null));
    assert.ok(!accountConfirmationMatches("", null));
    assert.ok(!accountConfirmationMatches(undefined, "a@b.co"));
  });

  it("pseudonymizes references but leaves hash-chained, append-only, personal and kept tables", () => {
    const targets = pseudonymizeTargets(catalog).map((t) => t.table);
    assert.deepEqual(targets, ["connections", "memory_facts", "pages"]);
    const mf = pseudonymizeTargets(catalog).find((t) => t.table === "memory_facts")!;
    assert.equal(mf.rls, true);
  });
});

describe("export plumbing", () => {
  it("filenames are slugged and dated", () => {
    assert.equal(exportFilename("workspace", "Bob's Bikes & Co!", new Date("2026-10-05T10:00:00Z")), "shapesos-workspace-bob-s-bikes-co-2026-10-05.json");
    assert.equal(exportFilename("account", "  ", new Date("2026-10-05T10:00:00Z")), "shapesos-account-export-2026-10-05.json");
  });

  it("one export per key; the slot frees when the stream ends or is cancelled", async () => {
    assert.ok(await claimExportSlot("k1"));
    assert.ok(!(await claimExportSlot("k1")));
    const src = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("{}"));
        c.close();
      },
    });
    assert.equal(await new Response(releasingStream(src, "k1")).text(), "{}");
    assert.ok(await claimExportSlot("k1"), "released at end of stream");
    const never = new ReadableStream<Uint8Array>({ pull() {} });
    await releasingStream(never, "k1").cancel();
    assert.ok(await claimExportSlot("k1"), "released on cancel");
    await releaseExportSlot("k1");
  });

  it("self-service guard: 401 signed out, the session's own account otherwise", async () => {
    const out = await requireSelfService(async () => null);
    assert.ok(out instanceof Response && out.status === 401);
    assert.deepEqual(await requireSelfService(async () => ({ id: "u1", email: "a@b.co" })), { id: "u1", email: "a@b.co", name: null });
  });
});
