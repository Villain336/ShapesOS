// ShapesOS Phase 4a — SCIM pure pieces: filters, PATCH folding (Okta and
// Entra ID shapes), group → role mapping, token format.
// Run: npx tsx --test lib/scim/__tests__/scim-parsing.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ScimError, parseEqFilter, pagination, scimBool } from "../http";
import { roleForGroupName, roleFromGroups, userPatchToAttrs } from "../service";
import { hashScimToken, mintScimToken, parseScimToken } from "../auth";

describe("filters", () => {
  it("parses attr eq \"value\" case-insensitively", () => {
    assert.deepEqual(parseEqFilter('userName eq "ada@example.com"', ["userName"]), { attr: "userName", value: "ada@example.com" });
    assert.deepEqual(parseEqFilter('USERNAME EQ "a\\"b"', ["userName"]), { attr: "userName", value: 'a"b' });
    assert.equal(parseEqFilter(null, ["userName"]), null);
  });
  it("rejects anything else instead of returning everyone", () => {
    for (const f of ['userName co "a"', 'name.familyName eq "x"', 'userName eq "a" or userName eq "b"', "userName pr"]) {
      assert.throws(() => parseEqFilter(f, ["userName"]), (e: unknown) => e instanceof ScimError && e.scimType === "invalidFilter", f);
    }
  });
  it("pagination is 1-based and capped", () => {
    assert.deepEqual(pagination(new URL("http://x/?startIndex=0&count=9999")), { startIndex: 1, count: 200 });
    assert.deepEqual(pagination(new URL("http://x/?startIndex=11&count=5")), { startIndex: 11, count: 5 });
  });
});

describe("PATCH folding", () => {
  it("Okta: replace with a value object", () => {
    assert.deepEqual(userPatchToAttrs([{ op: "replace", value: { active: false } }]), { active: false });
  });
  it("Entra ID: path + string booleans, emails filter path", () => {
    const a = userPatchToAttrs([
      { op: "replace", path: "active", value: "False" },
      { op: "replace", path: 'emails[type eq "work"].value', value: "New@Example.com" },
      { op: "replace", path: "name.givenName", value: "Ada" },
      { op: "replace", path: "displayName", value: "Ada L" },
    ]);
    assert.equal(a.active, false);
    assert.equal(a.email, "new@example.com");
    assert.equal(a.profile?.givenName, "Ada");
    assert.equal(a.displayName, "Ada L");
    assert.equal(scimBool("TRUE"), true);
  });
  it("rejects unknown paths and bad values", () => {
    assert.throws(() => userPatchToAttrs([{ op: "replace", path: "roles", value: "owner" }]), /Unsupported attribute path/);
    assert.throws(() => userPatchToAttrs([{ op: "replace", path: "active", value: "maybe" }]), /active must be a boolean/);
    assert.throws(() => userPatchToAttrs([{ op: "replace", path: "userName", value: "not-an-email" }]), /email/);
  });
});

describe("groups → roles", () => {
  it("derives the role from the displayName; never owner", () => {
    assert.equal(roleForGroupName("ShapesOS Admins"), "admin");
    assert.equal(roleForGroupName("editors"), "editor");
    assert.equal(roleForGroupName("Marketing viewer"), "viewer");
    assert.equal(roleForGroupName("Owners"), null);
    assert.equal(roleForGroupName("Everyone"), null);
  });
  it("highest group role wins; none → viewer", () => {
    assert.equal(roleFromGroups(["viewer", "admin", "editor"]), "admin");
    assert.equal(roleFromGroups([]), "viewer");
    assert.equal(roleFromGroups(["owner"]), "viewer");
  });
});

describe("token format", () => {
  it("names its workspace, hashes deterministically, rejects junk", () => {
    const t = mintScimToken("cmabc123workspace");
    assert.match(t.raw, /^scim_cmabc123workspace_[0-9a-f]{48}$/);
    assert.deepEqual(parseScimToken(t.raw), { workspaceId: "cmabc123workspace" });
    assert.equal(t.tokenHash, hashScimToken(t.raw));
    assert.ok(!t.tokenPrefix.includes(t.raw.slice(20, 40)), "prefix doesn't leak the secret part");
    assert.equal(parseScimToken("scim_ws_short"), null);
    assert.equal(parseScimToken("Bearer x"), null);
  });
});
