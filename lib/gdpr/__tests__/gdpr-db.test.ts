// ShapesOS — Phase 4a GDPR against the database, as the least-privilege app
// role (RLS and grants are the real ones), through the real route handlers:
//   - workspace export: admin+ only, every workspace-owned table (direct,
//     indirect, RLS), no other tenant's rows, no secrets, audited
//   - user export: the user's memberships and authored rows only
//   - account deletion: typed confirmation; refused while sole owner of a
//     shared workspace; deletes solo workspaces, leaves (and hands over)
//     shared ones, removes personal rows, pseudonymizes references (RLS
//     tables included), keeps hash-chained/append-only/lifecycle records
// Run: DATABASE_URL=… npx tsx --test --experimental-test-module-mocks lib/gdpr/__tests__/gdpr-db.test.ts

import "dotenv/config";
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";

const RUN = randomUUID().slice(0, 8);
const OWNER = `p4-gdpr-owner-${RUN}`;
const OWNER_EMAIL = `owner-${RUN}@gdpr.test`;
const ADMIN = `p4-gdpr-admin-${RUN}`;
const EDITOR = `p4-gdpr-editor-${RUN}`;
const STRANGER = `p4-gdpr-stranger-${RUN}`;
const SHARED = `p4-gdpr-shared-${RUN}`; // OWNER (owner) + ADMIN (admin) + EDITOR
const SOLO = `p4-gdpr-solo-${RUN}`; // OWNER alone
const OTHER = `p4-gdpr-other-${RUN}`; // STRANGER's workspace: must never leak

let actor: { id: string; email: string | null; name: string | null } | null = null;
mock.module("@/lib/session", {
  namedExports: {
    requireUser: async () => actor,
    ACTIVE_WORKSPACE_COOKIE: "marketr_active_workspace",
  },
});

type RouteCtx = { params: Promise<{ id: string }> };
let wsExport: { GET: (req: Request, ctx: RouteCtx) => Promise<Response> };
let accExport: { GET: (req: Request) => Promise<Response> };
let account: { GET: (req: Request) => Promise<Response>; DELETE: (req: Request) => Promise<Response> };

const ctx = (id: string): RouteCtx => ({ params: Promise.resolve({ id }) });
const get = (path: string) => new Request(`http://app${path}`, { headers: { "x-request-id": `req-${RUN}-0001` } });

async function insertWorkspace(id: string, owner: string, members: [string, string][]) {
  await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at) VALUES (${id}, ${`WS ${id}`}, ${owner}, now())`;
  for (const [userId, role] of members) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, updated_at) VALUES ($1, $2, $3, $4::"WorkspaceRole", now())`,
      `m-${id}-${userId}`,
      id,
      userId,
      role,
    );
  }
}

async function seed(ws: string, user: string, tag: string) {
  await prisma.project.create({ data: { id: `proj-${tag}`, workspaceId: ws, domain: `${tag}.test` } });
  await prisma.$executeRaw`INSERT INTO connector_connections (id, connector_key, workspace_id, user_id, scopes)
    VALUES (${`conn-${tag}`}, 'ga4', ${ws}, ${user}, '{}')`;
  await prisma.$executeRaw`INSERT INTO connector_credentials (connection_id, encrypted_blob, updated_at)
    VALUES (${`conn-${tag}`}, ${`CIPHERTEXT-${tag}`}, now())`;
  await prisma.$executeRaw`INSERT INTO mcp_api_keys (id, workspace_id, user_id, name, key_hash, key_prefix, scopes)
    VALUES (${`key-${tag}`}, ${ws}, ${user}, 'k', ${`KEYHASH-${tag}`}, 'mcpk_x', '{}')`;
  await prisma.$executeRaw`INSERT INTO notifications (id, workspace_id, user_id, kind, title)
    VALUES (${`n-${tag}`}, ${ws}, ${user}, 'alert_fired', ${`Note ${tag}`})`;
  await prisma.fileChangeLog.create({
    data: { workspaceId: ws, filePath: "(test)", actor: "user", action: "workspace_renamed", summary: `by ${OWNER_EMAIL} ${tag}`, approvedBy: user },
  });
  await withWorkspaceScope(ws, async (tx) => {
    await tx.$executeRaw`INSERT INTO company_knowledge (id, workspace_id, kind, title, body, updated_at)
      VALUES (${`ck-${tag}`}, ${ws}, 'audience', ${`Knowledge ${tag}`}, '{}', now())`;
    await tx.$executeRaw`INSERT INTO command_audit (id, workspace_id, user_id, kind)
      VALUES (${`ca-${tag}`}, ${ws}, ${user}, 'ask')`;
  });
}

before(async () => {
  await insertWorkspace(SHARED, OWNER, [[OWNER, "owner"], [ADMIN, "admin"], [EDITOR, "editor"]]);
  await insertWorkspace(SOLO, OWNER, [[OWNER, "owner"]]);
  await insertWorkspace(OTHER, STRANGER, [[STRANGER, "owner"]]);
  await seed(SHARED, OWNER, `shared-${RUN}`);
  await seed(SOLO, OWNER, `solo-${RUN}`);
  await seed(OTHER, STRANGER, `other-${RUN}`);
  // A row in SHARED authored by someone else: must not appear in OWNER's export.
  await prisma.fileChangeLog.create({
    data: { workspaceId: SHARED, filePath: "(test)", actor: "user", action: "workspace_renamed", summary: `admin-${RUN}`, approvedBy: ADMIN },
  });
  wsExport = await import("@/app/api/workspaces/[id]/export/route");
  accExport = await import("@/app/api/account/export/route");
  account = await import("@/app/api/account/route");
});

after(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [SHARED, SOLO, OTHER] } } });
  await prisma.workspaceLifecycleEvent.deleteMany({ where: { workspaceId: { in: [SHARED, SOLO, OTHER] } } });
  await prisma.$disconnect();
});

describe("workspace export", () => {
  it("is admin-only", async () => {
    actor = { id: EDITOR, email: null, name: null };
    assert.equal((await wsExport.GET(get(`/api/workspaces/${SHARED}/export`), ctx(SHARED))).status, 403);
    actor = { id: STRANGER, email: null, name: null };
    assert.equal((await wsExport.GET(get(`/api/workspaces/${SHARED}/export`), ctx(SHARED))).status, 403);
    actor = null;
    assert.equal((await wsExport.GET(get(`/api/workspaces/${SHARED}/export`), ctx(SHARED))).status, 401);
  });

  it("streams every workspace-owned table, RLS and indirect ones included, and nothing else", async () => {
    actor = { id: ADMIN, email: null, name: null };
    const res = await wsExport.GET(get(`/api/workspaces/${SHARED}/export`), ctx(SHARED));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="shapesos-workspace-ws-p4-gdpr-shared-.*\.json"/);
    const text = await res.text();
    const doc = JSON.parse(text) as {
      format: string;
      workspace: { id: string };
      tables: Record<string, Record<string, unknown>[]>;
      manifest: { tables: Record<string, { rows: number; omittedColumns: string[] }>; omittedTables: string[] };
    };
    assert.equal(doc.format, "shapesos.workspace-export");
    assert.equal(doc.workspace.id, SHARED);
    assert.ok(doc.tables.projects?.some((r) => r.id === `proj-shared-${RUN}`));
    assert.ok(doc.tables.company_knowledge?.some((r) => r.id === `ck-shared-${RUN}`), "FORCE-RLS table exported under scope");
    assert.ok(doc.tables.connector_credentials?.some((r) => r.connection_id === `conn-shared-${RUN}`), "indirect (FK) table exported");
    assert.ok(doc.tables.workspace_members?.length === 3);
    // No other tenant, no secrets.
    assert.doesNotMatch(text, new RegExp(`other-${RUN}|${OTHER}`));
    assert.doesNotMatch(text, /CIPHERTEXT-|KEYHASH-/);
    assert.doesNotMatch(JSON.stringify(doc.tables), /"(encrypted_blob|key_hash|invite_token)"/, "secret columns never appear as data");
    assert.ok(doc.manifest.tables.connector_credentials?.omittedColumns.includes("encrypted_blob"));
    assert.ok(doc.manifest.tables.mcp_api_keys?.omittedColumns.includes("key_hash"));
    assert.ok(doc.manifest.omittedTables.includes("mcp_oauth_tokens"));
    const audit = await prisma.fileChangeLog.count({ where: { workspaceId: SHARED, action: "workspace_exported", approvedBy: ADMIN } });
    assert.equal(audit, 1, "the download is audited");
  });

  it("refuses a second concurrent export of the same workspace", async () => {
    actor = { id: OWNER, email: OWNER_EMAIL, name: null };
    const first = await wsExport.GET(get(`/api/workspaces/${SHARED}/export`), ctx(SHARED));
    assert.equal(first.status, 200);
    const second = await wsExport.GET(get(`/api/workspaces/${SHARED}/export`), ctx(SHARED));
    assert.equal(second.status, 429);
    await first.text(); // drain → slot released
    const third = await wsExport.GET(get(`/api/workspaces/${SHARED}/export`), ctx(SHARED));
    assert.equal(third.status, 200);
    await third.text();
  });
});

describe("user export", () => {
  it("holds the user's memberships and authored rows only", async () => {
    actor = { id: OWNER, email: OWNER_EMAIL, name: "Owner" };
    const res = await accExport.GET(get("/api/account/export"));
    assert.equal(res.status, 200);
    const text = await res.text();
    const doc = JSON.parse(text) as {
      account: { id: string; email: string };
      memberships: { workspaceId: string; role: string }[];
      authored: Record<string, Record<string, unknown>[]>;
    };
    assert.equal(doc.account.id, OWNER);
    assert.deepEqual(doc.memberships.map((m) => m.workspaceId).sort(), [SHARED, SOLO].sort());
    assert.ok(doc.authored.notifications?.some((r) => r.id === `n-shared-${RUN}`));
    assert.ok(doc.authored.command_audit?.some((r) => r.id === `ca-solo-${RUN}`), "RLS table read under each workspace's scope");
    assert.ok(doc.authored.file_change_log?.every((r) => r.approved_by === OWNER));
    assert.doesNotMatch(text, new RegExp(`admin-${RUN}|${OTHER}|CIPHERTEXT-|KEYHASH-`));
  });
});

describe("account deletion", () => {
  it("previews what would happen, and refuses while the sole owner of a shared workspace", async () => {
    actor = { id: OWNER, email: OWNER_EMAIL, name: null };
    const preview = (await (await account.GET(get("/api/account"))).json()) as {
      confirmText: string;
      blockers: { workspaceId: string; reason: string }[];
      deleteWorkspaces: { id: string }[];
    };
    assert.equal(preview.confirmText, OWNER_EMAIL);
    assert.deepEqual(preview.blockers.map((b) => [b.workspaceId, b.reason]), [[SHARED, "sole_owner_with_members"]]);
    assert.deepEqual(preview.deleteWorkspaces.map((w) => w.id), [SOLO]);
    const res = await account.DELETE(new Request("http://app/api/account", { method: "DELETE", body: JSON.stringify({ confirm: OWNER_EMAIL }) }));
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /only owner/);
    assert.equal(await prisma.workspace.count({ where: { id: SOLO } }), 1, "nothing changed");
  });

  it("needs the email typed back", async () => {
    await prisma.workspaceMember.updateMany({ where: { workspaceId: SHARED, userId: ADMIN }, data: { role: "owner" } });
    const res = await account.DELETE(new Request("http://app/api/account", { method: "DELETE", body: JSON.stringify({ confirm: "yes" }) }));
    assert.equal(res.status, 400);
  });

  it("deletes the account: solo workspace gone, shared one left and handed over, personal rows gone, references pseudonymized", async () => {
    const res = await account.DELETE(
      new Request("http://app/api/account", { method: "DELETE", body: JSON.stringify({ confirm: OWNER_EMAIL.toUpperCase() }) }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { deletedWorkspaces: string[]; leftWorkspaces: string[] };
    assert.deepEqual(body.deletedWorkspaces, [SOLO]);
    assert.deepEqual(body.leftWorkspaces, [SHARED]);
    const cookies = res.headers.getSetCookie().join("\n");
    assert.match(cookies, /authjs\.session-token=;/);

    assert.equal(await prisma.workspace.count({ where: { id: SOLO } }), 0);
    const shared = await prisma.workspace.findUniqueOrThrow({ where: { id: SHARED } });
    assert.equal(shared.ownerUserId, ADMIN, "ownership handed to the other owner");
    assert.equal(await prisma.workspaceMember.count({ where: { userId: OWNER } }), 0);
    assert.equal(await prisma.notification.count({ where: { userId: OWNER } }), 0);
    assert.equal(await prisma.mcpApiKey.count({ where: { userId: OWNER } }), 0);

    // References pseudonymized — plain and RLS tables — and the email scrubbed.
    assert.equal(await prisma.fileChangeLog.count({ where: { approvedBy: OWNER } }), 0);
    const left = await prisma.fileChangeLog.findFirstOrThrow({ where: { workspaceId: SHARED, action: "member_removed" } });
    assert.match(left.approvedBy ?? "", /^deleted-user-[0-9a-f]{12}$/);
    assert.equal(await prisma.fileChangeLog.count({ where: { summary: { contains: OWNER_EMAIL } } }), 0);
    const conn = await prisma.$queryRaw<{ user_id: string }[]>`SELECT user_id FROM connector_connections WHERE id = ${`conn-shared-${RUN}`}`;
    assert.equal(conn[0]?.user_id, left.approvedBy, "one pseudonym per deletion");
    const audit = await withWorkspaceScope(SHARED, (tx) =>
      tx.$queryRaw<{ user_id: string }[]>`SELECT user_id FROM command_audit WHERE id = ${`ca-shared-${RUN}`}`,
    );
    assert.equal(audit[0]?.user_id, left.approvedBy, "RLS table rewritten under scope");

    // The other members and tenant are untouched; the lifecycle record of the deletion stays.
    assert.equal(await prisma.workspaceMember.count({ where: { workspaceId: SHARED } }), 2);
    // ADMIN's own rows (the seeded one + the export audit) keep their author.
    assert.equal(await prisma.fileChangeLog.count({ where: { approvedBy: ADMIN } }), 2);
    assert.equal(await prisma.mcpApiKey.count({ where: { userId: STRANGER } }), 1);
    const ev = await prisma.workspaceLifecycleEvent.findFirst({ where: { workspaceId: SOLO, action: "deleted" } });
    assert.equal(ev?.actorUserId, OWNER);
    assert.deepEqual(ev?.detail, { reason: "account_deleted" });
  });
});
