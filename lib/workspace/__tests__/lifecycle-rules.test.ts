// ShapesOS — Phase 3: workspace lifecycle permission + validation rules (pure).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_WORKSPACE_NAME,
  canDeleteWorkspace,
  canRenameWorkspace,
  deleteConfirmationMatches,
  deleteWorkspaceError,
  normalizeWorkspaceName,
} from "../lifecycle";
import { parseClientInput } from "../clients";
import { defaultWorkspaceName } from "@/lib/session";
import { BadRequestError } from "@/lib/api/errors";

describe("workspace names", () => {
  it("trims and collapses whitespace", () => {
    assert.equal(normalizeWorkspaceName("  Acme \n  Plumbing "), "Acme Plumbing");
  });
  it("rejects empty, non-string, too long, and control characters", () => {
    assert.throws(() => normalizeWorkspaceName("   "), BadRequestError);
    assert.throws(() => normalizeWorkspaceName(42), BadRequestError);
    assert.throws(() => normalizeWorkspaceName("x".repeat(MAX_WORKSPACE_NAME + 1)), BadRequestError);
    assert.throws(() => normalizeWorkspaceName("Acme\u0007"), BadRequestError);
  });
  it("signup default names fit the limit", () => {
    assert.equal(defaultWorkspaceName("ana@example.com"), "ana's workspace");
    assert.equal(defaultWorkspaceName(null), "My workspace");
    const long = defaultWorkspaceName(`${"a".repeat(200)}@x.test`);
    assert.ok(long.length <= MAX_WORKSPACE_NAME);
    assert.equal(normalizeWorkspaceName(long), long);
  });
});

describe("lifecycle permissions", () => {
  it("rename is admin+", () => {
    assert.equal(canRenameWorkspace("owner"), true);
    assert.equal(canRenameWorkspace("admin"), true);
    assert.equal(canRenameWorkspace("editor"), false);
    assert.equal(canRenameWorkspace("viewer"), false);
    assert.equal(canRenameWorkspace(null), false);
  });
  it("delete is owner only", () => {
    assert.equal(canDeleteWorkspace("owner"), true);
    assert.equal(canDeleteWorkspace("admin"), false);
    assert.equal(canDeleteWorkspace(undefined), false);
  });
  it("the typed confirmation must match the name exactly", () => {
    assert.equal(deleteConfirmationMatches("Acme", "Acme"), true);
    assert.equal(deleteConfirmationMatches("  Acme ", "Acme"), true);
    assert.equal(deleteConfirmationMatches("acme", "Acme"), false);
    assert.equal(deleteConfirmationMatches("", ""), false);
    assert.equal(deleteConfirmationMatches(undefined, "Acme"), false);
  });

  const ok = { role: "owner" as const, typedName: "Acme", workspaceName: "Acme", accessibleCount: 2, subscription: null };
  it("allows an owner who typed the name and has another workspace", () => {
    assert.equal(deleteWorkspaceError(ok), null);
  });
  it("refuses non-owners first (403)", () => {
    assert.equal(deleteWorkspaceError({ ...ok, role: "admin" })?.status, 403);
    assert.equal(deleteWorkspaceError({ ...ok, role: "admin", typedName: "nope" })?.status, 403);
  });
  it("refuses a wrong confirmation (400)", () => {
    assert.equal(deleteWorkspaceError({ ...ok, typedName: "Acme Inc" })?.status, 400);
  });
  it("refuses the last workspace (409)", () => {
    assert.equal(deleteWorkspaceError({ ...ok, accessibleCount: 1 })?.status, 409);
  });
  it("refuses while a subscription still bills, unless it's set to cancel", () => {
    assert.equal(deleteWorkspaceError({ ...ok, subscription: { status: "active", cancelAtPeriodEnd: false } })?.status, 409);
    assert.equal(deleteWorkspaceError({ ...ok, subscription: { status: "past_due", cancelAtPeriodEnd: false } })?.status, 409);
    assert.equal(deleteWorkspaceError({ ...ok, subscription: { status: "active", cancelAtPeriodEnd: true } }), null);
    assert.equal(deleteWorkspaceError({ ...ok, subscription: { status: "canceled", cancelAtPeriodEnd: false } }), null);
  });
});

describe("agency client input", () => {
  it("validates a full create", () => {
    assert.deepEqual(parseClientInput({ name: " Bob's Bikes ", loginEmail: "Bob@Bikes.test" }, false), {
      name: "Bob's Bikes",
      loginEmail: "bob@bikes.test",
      viewerRole: "viewer",
      reportSchedule: null,
    });
    assert.throws(() => parseClientInput({ name: "x", loginEmail: "nope" }, false), BadRequestError);
    assert.throws(() => parseClientInput({ name: "x", loginEmail: "a@b.co", viewerRole: "owner" }, false), BadRequestError);
    assert.throws(() => parseClientInput({ name: "x", loginEmail: "a@b.co", reportSchedule: "0 9 * * 1" }, false), BadRequestError);
  });
  it("a patch only carries the fields sent", () => {
    assert.deepEqual(parseClientInput({ reportSchedule: "monthly" }, true), { reportSchedule: "monthly" });
    assert.deepEqual(parseClientInput({ reportSchedule: "" }, true), { reportSchedule: null });
  });
});
