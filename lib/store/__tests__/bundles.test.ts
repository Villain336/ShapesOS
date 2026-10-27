// ShapesOS Phase 24: Store bundles are a shortcut, not a bypass. No database.
// Run: npx tsx --test lib/store/__tests__/bundles.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUNDLES, getBundle, memberExistsInRegistry, memberId, planBundle } from "../bundles";
import type { StoreItem } from "../catalogue";

const item = (over: Partial<StoreItem> & Pick<StoreItem, "kind" | "key">): StoreItem => ({
  name: over.key,
  description: "",
  category: null,
  version: null,
  tools: [],
  tierCounts: null,
  permissions: [],
  installed: false,
  state: "available",
  install: { mode: "inline", minRole: "editor" },
  removable: true,
  source: "builtin",
  installedId: null,
  ...over,
} as StoreItem);

describe("bundle registry", () => {
  it("every member points at a real registry entry", async () => {
    // The connector registry pulls the full dependency tree (resend, ...);
    // an installed checkout has it. A sandbox without it still checks skills + templates.
    let connectorKeys: string[] | null = null;
    try {
      const { listBuiltinConnectors } = await import("@/lib/connectors/m21/registry");
      connectorKeys = listBuiltinConnectors().map((c) => c.key);
    } catch (e) {
      // Only a missing dependency may skip the connector check; any other
      // failure of the registry import is a real failure.
      if (!/Cannot find module/.test(String((e as Error)?.message))) throw e;
    }
    for (const b of BUNDLES) {
      for (const m of b.members) {
        if (m.kind === "connector" && connectorKeys === null) continue;
        assert.ok(memberExistsInRegistry(m, connectorKeys ?? []), `${b.key}: ${memberId(m)} missing from its registry`);
      }
    }
  });
  it("member ids are unique within a bundle and bundle keys are unique", () => {
    assert.equal(new Set(BUNDLES.map((b) => b.key)).size, BUNDLES.length);
    for (const b of BUNDLES) assert.equal(new Set(b.members.map(memberId)).size, b.members.length);
  });
  it("only registry kinds that carry their own install state appear (no MCP, no spend)", () => {
    for (const b of BUNDLES) for (const m of b.members) assert.ok(["skill", "mission_template", "connector"].includes(m.kind));
  });
});

describe("planBundle", () => {
  const bundle = { key: "t", name: "T", description: "", members: [
    { kind: "skill" as const, key: "s1", why: "" },
    { kind: "skill" as const, key: "s2", why: "" },
    { kind: "mission_template" as const, key: "m1", why: "" },
    { kind: "connector" as const, key: "c1", why: "" },
    { kind: "skill" as const, key: "gone", why: "" },
  ] };
  const items = [
    item({ kind: "skill", key: "s1", install: { mode: "inline", minRole: "editor", permission: "skills.install" } }),
    item({ kind: "skill", key: "s2", installed: true, state: "installed", install: { mode: "inline", minRole: "editor", permission: "skills.install" } }),
    item({ kind: "mission_template", key: "m1", install: { mode: "inline", minRole: "admin" } }),
    item({ kind: "connector", key: "c1", install: { mode: "link", href: "/dashboard/settings/connectors" }, permissions: [{ kind: "oauth", detail: "read" }] }),
  ];
  const by = (p: ReturnType<typeof planBundle>, k: string) => p.members.find((m) => m.key === k)!;

  it("connectors are never installable, whatever the role", () => {
    for (const role of ["viewer", "editor", "admin", "owner"]) {
      const p = planBundle(bundle, items, { role, canInstallSkills: true });
      assert.equal(by(p, "c1").action, "connect_separately");
      assert.equal(by(p, "c1").href, "/dashboard/settings/connectors");
    }
  });
  it("an editor without skills.install is blocked on skills and on admin-only templates", () => {
    const p = planBundle(bundle, items, { role: "editor", canInstallSkills: false });
    assert.equal(by(p, "s1").action, "blocked");
    assert.equal(by(p, "m1").action, "blocked");
    assert.equal(by(p, "s2").action, "already_installed");
    assert.equal(by(p, "gone").action, "unavailable");
  });
  it("an admin sees installable members", () => {
    const p = planBundle(bundle, items, { role: "admin", canInstallSkills: true });
    assert.equal(by(p, "s1").action, "installable");
    assert.equal(by(p, "m1").action, "installable");
  });
  it("carries the catalogue's needs for the confirmation", () => {
    const p = planBundle(bundle, items, { role: "admin", canInstallSkills: true });
    assert.deepEqual(by(p, "c1").needs, ["oauth: read"]);
  });
  it("getBundle resolves known keys only", () => {
    assert.ok(getBundle(BUNDLES[0].key));
    assert.equal(getBundle("nope"), undefined);
  });
});
