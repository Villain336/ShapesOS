// ShapesOS — Phase 3: workspace lifecycle against the database (run it as the
// least-privilege app role, so RLS and grants are the real ones).
//   - rename: admin+, audited (lifecycle trail + workspace audit log)
//   - delete: owner only, typed name, not the last workspace; cascades every
//     child row (append-only ledger, RLS tables, RESTRICT-linked children)
//     and leaves a lifecycle record that survives the cascade
//   - the usage ledger stays append-only for live workspaces
//   - every ON DELETE RESTRICT foreign key is covered by the cleanup list
// Run (DB suite): DATABASE_URL=… npx tsx --test lib/workspace/__tests__/lifecycle-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { meter } from "@/lib/metering/service";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "@/lib/api/errors";
import {
  RESTRICT_CHILD_CLEANUP,
  createWorkspaceForUser,
  deleteWorkspace,
  renameWorkspace,
} from "../lifecycle";
import { createClient, deleteClient, listClients, updateClient } from "../clients";
import { loadOnboardingState, saveBusinessProfile, completeOnboarding } from "../onboarding";

const RUN = randomUUID().slice(0, 8);
const OWNER = `p3-life-owner-${RUN}`;
const ADMIN = `p3-life-admin-${RUN}`;
const EDITOR = `p3-life-editor-${RUN}`;
const SELF = {} as NodeJS.ProcessEnv;

let keep = ""; // the owner's second workspace (so the first isn't their last)
let doomed = "";

before(async () => {
  keep = (await createWorkspaceForUser({ userId: OWNER, name: "Keeper", env: SELF })).id;
  doomed = (await createWorkspaceForUser({ userId: OWNER, name: "Doomed Co", env: SELF })).id;
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: doomed, userId: ADMIN, role: "admin" },
      { workspaceId: doomed, userId: EDITOR, role: "editor" },
    ],
  });
});

after(async () => {
  await prisma.workspace.deleteMany({ where: { ownerUserId: { in: [OWNER, ADMIN, EDITOR] } } });
  await prisma.workspaceLifecycleEvent.deleteMany({ where: { actorUserId: { in: [OWNER, ADMIN, EDITOR] } } });
  await prisma.$disconnect();
});

describe("create", () => {
  it("records the creation in the trail and the workspace's audit log", async () => {
    const ev = await prisma.workspaceLifecycleEvent.findFirst({ where: { workspaceId: doomed, action: "created" } });
    assert.equal(ev?.actorUserId, OWNER);
    const log = await prisma.fileChangeLog.findFirst({ where: { workspaceId: doomed, action: "workspace_created" } });
    assert.ok(log);
  });
});

describe("rename", () => {
  it("an editor can't rename", async () => {
    await assert.rejects(() => renameWorkspace({ userId: EDITOR, workspaceId: doomed, name: "Nope" }), ForbiddenError);
  });
  it("a stranger gets not-found, not a hint", async () => {
    await assert.rejects(() => renameWorkspace({ userId: `nobody-${RUN}`, workspaceId: doomed, name: "x" }), NotFoundError);
  });
  it("an admin renames, audited", async () => {
    const ws = await renameWorkspace({ userId: ADMIN, workspaceId: doomed, name: "  Doomed   Inc " });
    assert.equal(ws.name, "Doomed Inc");
    const ev = await prisma.workspaceLifecycleEvent.findFirst({ where: { workspaceId: doomed, action: "renamed" } });
    assert.deepEqual(ev?.detail, { from: "Doomed Co", to: "Doomed Inc" });
    const log = await prisma.fileChangeLog.findFirst({ where: { workspaceId: doomed, action: "workspace_renamed" } });
    assert.match(log?.summary ?? "", /Doomed Inc/);
  });
});

describe("agency clients + onboarding context (same workspace, removed by the delete below)", () => {
  it("client CRUD is audited and validates", async () => {
    const c = await createClient(doomed, ADMIN, { name: "Bob's Bikes", loginEmail: "bob@bikes.test", reportSchedule: "weekly" });
    await assert.rejects(() => createClient(doomed, ADMIN, { name: "Dup", loginEmail: "BOB@bikes.test" }), ConflictError);
    await updateClient(doomed, ADMIN, c.id, { viewerRole: "editor" });
    await assert.rejects(() => updateClient(keep, ADMIN, c.id, { name: "x" }), NotFoundError, "other workspace can't touch it");
    const list = await listClients(doomed);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.viewerRole, "editor");
    await assert.rejects(() => deleteClient(doomed, ADMIN, c.id, "bob's bikes"), BadRequestError);
    const second = await createClient(doomed, ADMIN, { name: "Keep Me", loginEmail: "keep@me.test" });
    await deleteClient(doomed, ADMIN, c.id, "Bob's Bikes");
    assert.deepEqual((await listClients(doomed)).map((x) => x.id), [second.id]);
    const actions = (await prisma.fileChangeLog.findMany({ where: { workspaceId: doomed, action: { in: ["client_created", "client_updated", "client_deleted"] } } })).map((l) => l.action);
    assert.equal(actions.filter((a) => a === "client_created").length, 2);
    assert.ok(actions.includes("client_updated") && actions.includes("client_deleted"));
  });

  it("the business profile lands in company knowledge and seeds the first project", async () => {
    const r = await saveBusinessProfile(doomed, { businessType: "local_service", website: "doomed.test", goals: ["leads"], notes: null });
    assert.equal(r.projectCreated, true);
    await saveBusinessProfile(doomed, { businessType: "agency", website: "other.test", goals: [], notes: "x" });
    const state = await loadOnboardingState(doomed);
    assert.equal(state.profile.businessType, "agency", "saving again updates the one entry");
    assert.equal(state.hasProject, true);
    assert.equal(await prisma.project.count({ where: { workspaceId: doomed } }), 1, "only the first website makes a project");
    const n = await withWorkspaceScope(doomed, (tx) => tx.companyKnowledge.count({ where: { workspaceId: doomed } }));
    assert.equal(n, 1);
    await completeOnboarding(doomed);
    assert.equal((await loadOnboardingState(doomed)).completed, true);
  });
});

describe("delete", () => {
  before(async () => {
    // Fill the workspace with rows that make a delete hard: append-only
    // ledger rows (with and without a project), RESTRICT-linked children,
    // and an RLS-protected table.
    const project = await prisma.project.findFirstOrThrow({ where: { workspaceId: doomed } });
    for (const projectId of [null, project.id]) {
      const r = await meter({ workspaceId: doomed, projectId, action: "rank_check", idempotencyKey: `p3-life-${randomUUID()}`, credits: 3 });
      assert.equal(r.ok, true);
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO insurance_carriers (id, workspace_id, name, appointment_path, updated_at) VALUES ($1, $2, 'Carrier', 'direct', now())`,
      `car-${RUN}`, doomed,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO insurance_policies (id, workspace_id, carrier_id, policy_number, named_insured, line, effective_at, expires_at, updated_at)
       VALUES ($1, $2, $3, 'PN-1', 'Doomed', 'gl', now(), now() + interval '1 year', now())`,
      `pol-${RUN}`, doomed, `car-${RUN}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO insurance_certificates (id, workspace_id, policy_id, holder_name, issue_date, valid_from, valid_to, updated_at)
       VALUES ($1, $2, $3, 'Holder', now(), now(), now() + interval '1 year', now())`,
      `cert-${RUN}`, doomed, `pol-${RUN}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO wfh_expense_categories (id, workspace_id, user_id, key, name, description) VALUES ($1, $2, $3, 'home', 'Home', 'd')`,
      `cat-${RUN}`, doomed, OWNER,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO wfh_expenses (id, workspace_id, user_id, category_id, amount_cents, occurred_on, allocation_method, allocation_pct, deductible_cents)
       VALUES ($1, $2, $3, $4, 100, now(), 'full', 1, 100)`,
      `exp-${RUN}`, doomed, OWNER, `cat-${RUN}`,
    );
  });

  it("the usage ledger stays append-only while the workspace lives", async () => {
    await assert.rejects(() => prisma.$executeRaw`DELETE FROM usage_events WHERE workspace_id = ${doomed}`, /append-only/);
    await assert.rejects(() => prisma.$executeRaw`UPDATE usage_events SET credits = 0 WHERE workspace_id = ${doomed}`, /append-only/);
  });

  it("a project with ledger rows can be deleted (the ledger keeps the rows, unlinked)", async () => {
    const p = await prisma.project.create({ data: { workspaceId: keep, domain: `p-${RUN}.test` } });
    const r = await meter({ workspaceId: keep, projectId: p.id, action: "rank_check", idempotencyKey: `p3-life-${randomUUID()}`, credits: 1 });
    assert.equal(r.ok, true);
    await prisma.project.delete({ where: { id: p.id } });
    const row = await prisma.usageEvent.findUnique({ where: { id: r.ok ? r.eventId : "" } });
    assert.equal(row?.projectId, null);
    assert.equal(row?.credits, 1);
  });

  it("only an owner may delete", async () => {
    await assert.rejects(() => deleteWorkspace({ userId: ADMIN, workspaceId: doomed, confirmName: "Doomed Inc" }), ForbiddenError);
    await assert.rejects(() => deleteWorkspace({ userId: `nobody-${RUN}`, workspaceId: doomed, confirmName: "Doomed Inc" }), NotFoundError);
  });

  it("needs the name typed exactly", async () => {
    await assert.rejects(() => deleteWorkspace({ userId: OWNER, workspaceId: doomed, confirmName: "doomed inc" }), BadRequestError);
    await assert.rejects(() => deleteWorkspace({ userId: OWNER, workspaceId: doomed, confirmName: undefined }), BadRequestError);
  });

  it("refuses a person's last workspace", async () => {
    const solo = `p3-life-solo-${RUN}`;
    const ws = await createWorkspaceForUser({ userId: solo, name: "Solo", env: SELF });
    try {
      await assert.rejects(() => deleteWorkspace({ userId: solo, workspaceId: ws.id, confirmName: "Solo" }), ConflictError);
    } finally {
      await prisma.workspace.delete({ where: { id: ws.id } });
      await prisma.workspaceLifecycleEvent.deleteMany({ where: { actorUserId: solo } });
    }
  });

  it("deletes the workspace and everything in it, and keeps the record", async () => {
    const r = await deleteWorkspace({ userId: OWNER, workspaceId: doomed, confirmName: "Doomed Inc" });
    assert.equal(r.deletedId, doomed);
    assert.equal(await prisma.workspace.count({ where: { id: doomed } }), 0);
    for (const table of ["usage_events", "projects", "workspace_members", "clients", "insurance_certificates", "insurance_policies", "wfh_expenses", "credit_balances", "file_change_log"]) {
      const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${table}" WHERE workspace_id = $1`, doomed);
      assert.equal(rows[0]?.n, 0, `${table} rows left behind`);
    }
    const knowledge = await withWorkspaceScope(doomed, (tx) => tx.companyKnowledge.count({ where: { workspaceId: doomed } }));
    assert.equal(knowledge, 0);
    const ev = await prisma.workspaceLifecycleEvent.findFirst({ where: { workspaceId: doomed, action: "deleted" } });
    assert.equal(ev?.actorUserId, OWNER);
    assert.equal(ev?.workspaceName, "Doomed Inc");
    // The other workspace is untouched.
    assert.equal(await prisma.workspace.count({ where: { id: keep } }), 1);
  });
});

describe("cascade-safety guard", () => {
  it("every ON DELETE RESTRICT foreign key is cleared before the cascade", async () => {
    const rows = await prisma.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
       WHERE contype = 'f' AND confdeltype = 'r' AND connamespace = 'public'::regnamespace
       ORDER BY conname`;
    const covered = new Set(RESTRICT_CHILD_CLEANUP.map((s) => s.fk));
    const missing = rows.map((r) => r.conname).filter((n) => !covered.has(n));
    assert.deepEqual(missing, [], "add these to RESTRICT_CHILD_CLEANUP in lib/workspace/lifecycle.ts");
  });
});
