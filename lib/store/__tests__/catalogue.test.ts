// ShapesOS — Phase 18.2 (WS=content): the Store's listing generation from
// each REAL registry (lib/store/catalogue.ts + the tier resolvers in
// lib/store/service.ts) — no copies, and tiers that match run time:
//   - skills: every registry pack; installed state from the workspace's rows;
//     URL / upload / agency skills listed as their own items; declared tools
//     resolved to connector or agent tools (unknown → Tier 2, flagged)
//   - mission templates: every template; removed ones show as available
//   - mini-apps: installed = published; actions at their effective tier
//   - Composio: risk tiers → approval tiers
//   - built-in connectors: every connector, every adapter tool; reads Tier 0;
//     writes at their action's tier; money / deletion words → Tier 3 and
//     "always asks" (the Store never shows a write lower than run time does)
//   - MCP servers: read-only tools Tier 0, policies at their action's tier
//   - filter / sort / maxTier

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  connectorItems,
  connectorToolTier,
  filterCatalogue,
  maxTier,
  mcpItems,
  miniAppItems,
  skillItems,
  sortCatalogue,
  templateItems,
  toolkitItems,
  type StoreItem,
} from "../catalogue";
import { builtinConnectorTools, resolveDeclaredTool } from "../service";
import { listRegistryPacks } from "@/lib/skills/registry";
import { MISSION_TEMPLATES, BUSINESS_TYPE_LABELS } from "@/lib/missions/templates";
import { listBuiltinConnectors } from "@/lib/connectors/m21/registry";
import { NEVER_AUTO_ACTIONS } from "@/lib/automation/policy";

const templates = () =>
  MISSION_TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, businessTypeLabel: BUSINESS_TYPE_LABELS[t.businessType], plan: t.plan, budgetDefaults: t.budgetDefaults }));

describe("Store catalogue generation", () => {
  it("skills: every registry pack, installed state from the workspace, own skills listed separately", () => {
    const packs = listRegistryPacks();
    assert.ok(packs.length >= 5);
    const none = skillItems(packs, [], resolveDeclaredTool);
    assert.equal(none.length, packs.length, "one item per pack, nothing copied");
    assert.ok(none.every((i) => i.kind === "skill" && !i.installed && i.source === "builtin"));
    assert.deepEqual(none.map((i) => i.key).sort(), packs.map((p) => p.key).sort());
    const items = skillItems(
      packs,
      [
        { id: "sk1", name: "SEO Audit", description: "x", version: "1.2.0", source: "registry", sourceRef: "seo-audit", declaredTools: [] },
        { id: "sk2", name: "Our playbook", description: "custom", version: "1.0.0", source: "upload", sourceRef: "ours.md", declaredTools: ["gmail.send_email"] },
        { id: "sk3", name: "Agency skill", description: "", version: "1.0.0", source: "upload", sourceRef: "a.md", declaredTools: [] },
      ],
      resolveDeclaredTool,
      new Set(["sk3"]),
    );
    const seo = items.find((i) => i.key === "seo-audit")!;
    assert.equal(seo.installed, true);
    assert.equal(seo.installedId, "sk1");
    const own = items.find((i) => i.key === "installed:sk2")!;
    assert.equal(own.source, "workspace");
    assert.equal(own.tools[0]!.tier, 2, "gmail.send_email is an external send: Tier 2");
    assert.equal(items.find((i) => i.key === "installed:sk3")!.source, "agency");
    assert.equal(items.length, packs.length + 2);
  });

  it("skills: declared tools resolve to connector or agent tools; unknown ones are Tier 2 and flagged", () => {
    const read = resolveDeclaredTool("google-search-console.query_performance");
    assert.deepEqual([read?.tier, read?.alwaysAsks], [0, false], "a connector read");
    const image = resolveDeclaredTool("media.generate_image");
    assert.ok(image, "resolves the agent tool generate_image");
    assert.ok(image!.tier >= 1, "a metered agent tool is never Tier 0");
    assert.equal(resolveDeclaredTool("dataforseo.nonexistent_tool_xyz"), null);
    const [item] = skillItems([{ key: "k", name: "K", description: "", version: "1", declaredTools: ["nope.tool"] }], [], resolveDeclaredTool);
    assert.deepEqual([item!.tools[0]!.tier, item!.tools[0]!.unresolved], [2, true]);
  });

  it("mission templates: every template; a removed one shows as available", () => {
    const all = templateItems(templates(), new Set());
    assert.equal(all.length, MISSION_TEMPLATES.length);
    assert.ok(all.every((i) => i.installed));
    const first = MISSION_TEMPLATES[0]!;
    const some = templateItems(templates(), new Set([first.id]), new Set([MISSION_TEMPLATES[1]!.id]));
    assert.equal(some.find((i) => i.key === first.id)!.installed, false);
    assert.equal(some.find((i) => i.key === MISSION_TEMPLATES[1]!.id)!.source, "agency");
    const item = some.find((i) => i.key === first.id)!;
    assert.equal(item.tools.length, first.plan.length, "the plan's steps at their tiers");
    assert.ok(item.permissions.some((p) => p.kind === "budget"));
    assert.ok(item.permissions.some((p) => p.kind === "approvals"), "templates with approval steps say so");
  });

  it("mini-apps: installed = published; actions at their tier", () => {
    const [draft, live] = miniAppItems(
      [
        { slug: "crm", name: "CRM", description: null, version: 0, published: false, entities: ["Deals"], actions: [] },
        { slug: "inv", name: "Inventory", description: "Stock", version: 3, published: true, entities: ["Items"], actions: [{ key: "del", label: "Delete item", tier: 1 }] },
      ],
      new Set(["inv"]),
    );
    assert.deepEqual([draft!.installed, draft!.state, draft!.source], [false, "draft", "workspace"]);
    assert.deepEqual([live!.installed, live!.state, live!.version, live!.source], [true, "published", "v3", "agency"]);
    assert.equal(live!.tools[0]!.tier, 1);
  });

  it("Composio toolkits: risk tiers become approval tiers", () => {
    const [tk] = toolkitItems([
      { toolkitSlug: "slack", label: "Slack", description: "", category: "communication", connected: false, enabled: true, toolCount: 9, tierBreakdown: { low: 4, medium: 3, high: 1, unclassified: 1 } },
    ]);
    assert.deepEqual(tk!.tierCounts, { tier0: 4, tier2: 3, tier3: 1, unclassified: 1 });
    assert.equal(maxTier(tk!), 3, "high-risk or unclassified → up to Tier 3");
    assert.deepEqual([tk!.installed, tk!.state], [true, "enabled"]);
  });

  it("built-in connectors: every connector, every adapter tool, at run-time tiers", () => {
    const metas = listBuiltinConnectors();
    const items = connectorItems(
      metas.map((c) => ({
        key: c.key,
        displayName: c.displayName,
        description: c.description,
        authType: c.authType,
        scopes: c.oauth?.scopes ?? [],
        platformKeyEnv: c.platformKey?.envVar ?? null,
        tools: builtinConnectorTools(c.key),
        connections: c.key === "gmail" ? 1 : 0,
      })),
    );
    assert.equal(items.length, metas.length);
    assert.ok(items.every((i) => i.install.mode === "link"), "connecting needs credentials: Settings → Connectors");
    const gmail = items.find((i) => i.key === "gmail")!;
    assert.deepEqual([gmail.installed, gmail.state], [true, "connected"]);
    assert.ok(gmail.permissions.some((p) => p.kind === "oauth" && p.detail.length > 0), "OAuth scopes shown");
    const send = gmail.tools.find((t) => t.name === "send_email")!;
    assert.equal(send.tier, 2, "an email to anyone: Tier 2");
    const qb = items.find((i) => i.key === "quickbooks")!;
    const post = qb.tools.find((t) => t.name === "post_to_quickbooks")!;
    assert.deepEqual([post.tier, post.alwaysAsks], [3, true], "posting the books: Tier 3, always asks");
    // Money safety: every write on a money connector is Tier 3; no Tier-3 tool is ever shown as automatable.
    for (const key of ["quickbooks", "xero", "gusto"]) {
      const item = items.find((i) => i.key === key)!;
      for (const t of item.tools) if (t.tier === 3) assert.equal(t.alwaysAsks, true, `${key}.${t.name}`);
    }
    for (const item of items) for (const t of item.tools) if (t.tier === 3) assert.equal(t.alwaysAsks, true, `${item.key}.${t.name}`);
    const gsc = items.find((i) => i.key === "google-search-console")!;
    assert.ok(gsc.tools.some((t) => t.tier === 0), "reads are Tier 0");
  });

  it("connector tools: deletion words are Tier 3 whatever the action says; never-auto actions always ask", () => {
    const del = connectorToolTier({ name: "delete_post", description: "Delete a social post", mutating: true }, "delete_social_post");
    assert.deepEqual([del.tier, del.alwaysAsks], [3, true]);
    const destructive = connectorToolTier({ name: "drop", description: "Drop rows", mutating: true, destructive: true }, "mcp_write");
    assert.equal(destructive.alwaysAsks, true);
    const anyNever = [...NEVER_AUTO_ACTIONS.keys()][0];
    if (anyNever) assert.equal(connectorToolTier({ name: "x", description: "x", mutating: true }, anyNever, { neverAuto: NEVER_AUTO_ACTIONS }).alwaysAsks, true);
    assert.deepEqual(connectorToolTier({ name: "list", description: "List things", mutating: false }, null), { name: "list", description: "List things", tier: 0, alwaysAsks: false });
  });

  it("MCP servers: read-only tools Tier 0, the rest at their policy's tier", () => {
    const [m] = mcpItems([
      {
        id: "c1",
        key: "acme-mcp",
        displayName: "Acme",
        endpoint: "https://mcp.acme.test",
        tools: [connectorToolTier({ name: "search", description: "", mutating: false }, null), connectorToolTier({ name: "write_note", description: "", mutating: true }, "mcp_write")],
        connections: 0,
      },
    ]);
    assert.deepEqual(m!.tools.map((t) => t.tier), [0, 2]);
    assert.equal(m!.install.mode, "link");
    assert.equal(m!.installedId, "c1");
  });

  it("filter, sort and the highest tier", () => {
    const items: StoreItem[] = [
      ...templateItems(templates().slice(0, 2), new Set([templates()[0]!.id])),
      ...skillItems(listRegistryPacks().slice(0, 2), [], resolveDeclaredTool),
    ];
    const sorted = sortCatalogue(items);
    assert.equal(sorted[0]!.kind, "skill", "kinds in Store order (skills before templates)");
    assert.equal(filterCatalogue(items, { kind: "mission_template" }).length, 2);
    assert.equal(filterCatalogue(items, { kind: "mission_template", installedOnly: true }).length, 1);
    const name = items[0]!.name.split(" ")[0]!.toLowerCase();
    assert.ok(filterCatalogue(items, { q: name }).some((i) => i.name.toLowerCase().includes(name)));
    assert.equal(maxTier({ tools: [], tierCounts: null }), null);
  });
});
