// ShapesOS — Phase 18.2 (WS=content): the Store against real Postgres.
//   - the catalogue lists every kind from its registry with THIS workspace's
//     state; another workspace's installs never show
//   - install / remove per workspace through each kind's existing path and
//     permission: a registry skill (admin or skills.install; an editor is
//     refused), a mission template (admin; removed = hidden from the picker
//     and refused by the Missions API's check), a mini-app (publish /
//     unpublish, admin), a Composio toolkit (editor); connectors and MCP
//     servers are refused with where to connect them; all audited
//   - agency publishing: an Agency-plan workspace's admin offers a skill, a
//     mini-app and a template to ITS client workspaces only; a client admin
//     accepts (installed in the client through the same paths) or declines;
//     an editor can't answer; answered offers can't be answered twice; the
//     agency withdraws a pending one; party isolation under FORCE RLS
//   - list_store_items (Tier 0, read-only)
// Run (as the least-privilege app role):
//   DATABASE_URL=… npx tsx --test lib/store/__tests__/store-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope, countWithoutScope } from "@/lib/substrate/memory/rls";
import { installFromUpload } from "@/lib/skills/importer";
import { REGISTRY_PACKS } from "@/lib/skills/registry";
import { MISSION_TEMPLATES } from "@/lib/missions/templates";
import { createApp } from "@/lib/apps/service";
import { getTool, toolGroup } from "@/lib/chat/tools";
import {
  decidePublication,
  installStoreItem,
  listClientWorkspaces,
  listPublications,
  loadStoreCatalogue,
  publishToClients,
  removeStoreItem,
  revokePublication,
  type StoreActor,
} from "../service";
import { removedMissionTemplates } from "../state";
import { list_store_items } from "../tools";

const RUN = randomUUID().slice(0, 8);
const WS = `p182s-${RUN}`;
const OTHER = `p182s-other-${RUN}`;
const AGENCY = `p182s-agency-${RUN}`;
const CLIENT = `p182s-client-${RUN}`;
const STRANGER = `p182s-stranger-${RUN}`; // an agency-plan workspace's non-client
const ADM = `p182s-adm-${RUN}`;
const ED = `p182s-ed-${RUN}`;
const VIC = `p182s-vic-${RUN}`;
const AG_ADM = `p182s-agadm-${RUN}`;
const CL_ADM = `p182s-cladm-${RUN}`;
const CL_ED = `p182s-cled-${RUN}`;
const adm: StoreActor = { workspaceId: WS, userId: ADM, role: "admin" };
const ed: StoreActor = { workspaceId: WS, userId: ED, role: "editor" };
const vic: StoreActor = { workspaceId: WS, userId: VIC, role: "viewer" };
const agAdm: StoreActor = { workspaceId: AGENCY, userId: AG_ADM, role: "admin" };
const clAdm: StoreActor = { workspaceId: CLIENT, userId: CL_ADM, role: "admin" };
const clEd: StoreActor = { workspaceId: CLIENT, userId: CL_ED, role: "editor" };
const PACK = REGISTRY_PACKS[0]!;
const TEMPLATE = MISSION_TEMPLATES[0]!;
const ALL = [WS, OTHER, AGENCY, CLIENT, STRANGER];

before(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: ALL } } });
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: ADM } });
  await prisma.workspace.create({ data: { id: OTHER, name: OTHER, ownerUserId: ADM } });
  await prisma.workspace.create({ data: { id: AGENCY, name: "Agency Co", ownerUserId: AG_ADM, plan: "agency" } });
  await prisma.workspace.create({ data: { id: CLIENT, name: "Client Ltd", ownerUserId: CL_ADM, creditPoolOwnerId: AGENCY } });
  await prisma.workspace.create({ data: { id: STRANGER, name: "Stranger", ownerUserId: CL_ADM } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: ADM, role: "admin", email: `adm-${RUN}@example.test` },
      { workspaceId: WS, userId: ED, role: "editor", email: `ed-${RUN}@example.test` },
      { workspaceId: WS, userId: VIC, role: "viewer", email: `vic-${RUN}@example.test` },
      { workspaceId: OTHER, userId: ADM, role: "admin", email: `adm-${RUN}@example.test` },
      { workspaceId: AGENCY, userId: AG_ADM, role: "admin", email: `agadm-${RUN}@example.test` },
      { workspaceId: CLIENT, userId: CL_ADM, role: "admin", email: `cladm-${RUN}@example.test` },
      { workspaceId: CLIENT, userId: CL_ED, role: "editor", email: `cled-${RUN}@example.test` },
      { workspaceId: STRANGER, userId: CL_ADM, role: "admin", email: `cladm-${RUN}@example.test` },
    ],
  });
});

after(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: ALL } } });
  await prisma.$disconnect();
});

async function item(actor: StoreActor, kind: string, key: string) {
  return (await loadStoreCatalogue(actor)).items.find((i) => i.kind === kind && i.key === key);
}

describe("Store (DB)", () => {
  it("lists every kind from its registry with this workspace's state", async () => {
    const cat = await loadStoreCatalogue(vic);
    const kinds = new Set(cat.items.map((i) => i.kind));
    for (const k of ["skill", "mission_template", "connector", "composio_toolkit"]) assert.ok(kinds.has(k as never), `lists ${k}`);
    assert.equal(cat.items.filter((i) => i.kind === "skill" && i.source === "builtin").length, REGISTRY_PACKS.length);
    assert.equal(cat.items.filter((i) => i.kind === "mission_template").length, MISSION_TEMPLATES.length);
    assert.ok(cat.items.every((i) => i.kind !== "skill" || !i.installed), "nothing installed yet");
  });

  it("a registry skill: admins install and remove it; editors without the grant can't; per workspace; audited", async () => {
    await assert.rejects(installStoreItem(ed, "skill", PACK.key), /skills\.install/);
    await assert.rejects(installStoreItem(vic, "skill", PACK.key), /skills\.install/);
    await installStoreItem(adm, "skill", PACK.key);
    assert.equal((await item(vic, "skill", PACK.key))?.installed, true);
    assert.equal((await item({ ...adm, workspaceId: OTHER }, "skill", PACK.key))?.installed, false, "another workspace is untouched");
    await assert.rejects(installStoreItem(adm, "skill", PACK.key), /already installed/);
    const rows = await prisma.skill.findMany({ where: { workspaceId: WS, sourceRef: PACK.key } });
    assert.equal(rows.length, 1, "the existing importer wrote one skill row");
    await removeStoreItem(adm, "skill", PACK.key);
    assert.equal(await prisma.skill.count({ where: { workspaceId: WS, sourceRef: PACK.key } }), 0, "uninstallSkill removed it");
    const audits = await prisma.fileChangeLog.findMany({ where: { workspaceId: WS, action: { in: ["store_item_installed", "store_item_removed", "skill_installed", "skill_uninstalled"] } } });
    assert.deepEqual(new Set(audits.map((a) => a.action)), new Set(["store_item_installed", "store_item_removed", "skill_installed", "skill_uninstalled"]));
  });

  it("a mission template: admins remove it from the picker (the Missions API refuses it) and add it back", async () => {
    await assert.rejects(removeStoreItem(ed, "mission_template", TEMPLATE.id), /admin role/);
    await removeStoreItem(adm, "mission_template", TEMPLATE.id);
    assert.ok((await removedMissionTemplates(WS)).has(TEMPLATE.id));
    assert.ok(!(await removedMissionTemplates(OTHER)).has(TEMPLATE.id), "per workspace");
    assert.equal((await item(vic, "mission_template", TEMPLATE.id))?.installed, false);
    await installStoreItem(adm, "mission_template", TEMPLATE.id);
    assert.ok(!(await removedMissionTemplates(WS)).has(TEMPLATE.id));
    await assert.rejects(installStoreItem(adm, "mission_template", "nope.template"), /No mission template/);
  });

  it("a mini-app: install = publish, remove = unpublish (admin)", async () => {
    await createApp({ workspaceId: WS, userId: ED, role: "editor" }, { name: "Field Visits", slug: `visits-${RUN}` });
    const slug = `visits-${RUN}`;
    assert.equal((await item(ed, "mini_app", slug))?.installed, false, "a draft");
    await assert.rejects(installStoreItem(ed, "mini_app", slug), /admin/);
    await installStoreItem(adm, "mini_app", slug);
    const live = await item(vic, "mini_app", slug);
    assert.deepEqual([live?.installed, live?.state], [true, "published"], "viewers see it once published");
    await removeStoreItem(adm, "mini_app", slug);
    assert.equal(await item(vic, "mini_app", slug), undefined, "unpublished: viewers no longer see it");
    assert.equal((await item(ed, "mini_app", slug))?.installed, false);
  });

  it("a Composio toolkit: editors turn it on and off for this workspace", async () => {
    await assert.rejects(installStoreItem(vic, "composio_toolkit", "salesforce"), /editor role/);
    await installStoreItem(ed, "composio_toolkit", "salesforce");
    assert.equal((await item(vic, "composio_toolkit", "salesforce"))?.installed, true);
    assert.equal((await item({ ...adm, workspaceId: OTHER }, "composio_toolkit", "salesforce"))?.installed, false);
    await removeStoreItem(ed, "composio_toolkit", "salesforce");
    assert.equal((await item(vic, "composio_toolkit", "salesforce"))?.installed, false);
  });

  it("connectors and MCP servers point to Settings → Connectors", async () => {
    await assert.rejects(installStoreItem(adm, "connector", "gmail"), /Settings → Connectors/);
    await assert.rejects(removeStoreItem(adm, "mcp_server", "anything"), /Settings → Connectors/);
    await assert.rejects(installStoreItem(adm, "rocket", "x"), /kind must be one of/);
    const gmail = await item(vic, "connector", "gmail");
    assert.equal(gmail?.install.mode, "link");
  });

  it("agency publishing: only to its own clients; client admin accepts or declines; installed through the same paths", async () => {
    assert.deepEqual((await listClientWorkspaces(AGENCY)).map((c) => c.id), [CLIENT]);
    assert.deepEqual(await listClientWorkspaces(WS), [], "not an agency");
    // The agency's own skill (uploaded there) and app.
    const md = PACK.skillMd.replace(/^name: .*$/m, `name: Agency Audit ${RUN}`);
    const agencySkill = await installFromUpload(prisma, AGENCY, md, "agency-audit.md", AG_ADM);
    const appSlug = `agency-app-${RUN}`;
    await createApp({ workspaceId: AGENCY, userId: AG_ADM, role: "admin" }, { name: "Agency App", slug: appSlug });
    await assert.rejects(publishToClients(agAdm, "mini_app", appSlug, [CLIENT]), /Publish the app/);
    await installStoreItem(agAdm, "mini_app", appSlug);

    await assert.rejects(publishToClients(agAdm, "skill", `installed:${agencySkill.id}`, [STRANGER]), /aren't your clients/);
    await assert.rejects(publishToClients({ ...agAdm, role: "editor" }, "skill", `installed:${agencySkill.id}`, [CLIENT]), /admin role/);
    await assert.rejects(publishToClients(adm, "skill", PACK.key, [CLIENT]), /Agency-plan/);
    await assert.rejects(publishToClients(agAdm, "connector", "gmail", [CLIENT]), /Only mini-apps, skills and mission templates/);

    const s = await publishToClients(agAdm, "skill", `installed:${agencySkill.id}`, [CLIENT]);
    const again = await publishToClients(agAdm, "skill", `installed:${agencySkill.id}`, [CLIENT]);
    assert.deepEqual(again.published, s.published, "offering again refreshes the pending offer");
    const a = await publishToClients(agAdm, "mini_app", appSlug, [CLIENT]);
    const t = await publishToClients(agAdm, "mission_template", TEMPLATE.id, [CLIENT]);

    const incoming = (await listPublications(clAdm)).incoming;
    assert.equal(incoming.filter((p) => p.status === "pending").length, 3);
    assert.ok(incoming.every((p) => p.party === "Agency Co"));
    assert.equal((await listPublications(agAdm)).outgoing.length, 3);
    assert.equal((await listPublications({ ...clAdm, workspaceId: STRANGER })).incoming.length, 0, "a non-client sees nothing");

    await assert.rejects(decidePublication(clEd, s.published[0]!, "accept"), /admin role/);
    const acceptedSkill = await decidePublication(clAdm, s.published[0]!, "accept");
    assert.equal(acceptedSkill.status, "accepted");
    const clientSkill = await prisma.skill.findFirst({ where: { workspaceId: CLIENT, name: `Agency Audit ${RUN}` } });
    assert.ok(clientSkill, "the skill was installed in the client workspace");
    await assert.rejects(decidePublication(clAdm, s.published[0]!, "accept"), /already accepted/);
    assert.equal((await item(clAdm, "skill", `installed:${clientSkill!.id}`))?.source, "agency");

    const acceptedApp = await decidePublication(clAdm, a.published[0]!, "accept");
    const clientApp = await withWorkspaceScope(CLIENT, (tx) => tx.miniApp.findFirst({ where: { workspaceId: CLIENT, slug: acceptedApp.installedKey! } }));
    assert.deepEqual([clientApp?.published, clientApp?.version], [true, 1], "created and published in the client");

    await removeStoreItem(clAdm, "mission_template", TEMPLATE.id);
    assert.equal((await decidePublication(clAdm, t.published[0]!, "decline")).status, "declined");
    assert.ok((await removedMissionTemplates(CLIENT)).has(TEMPLATE.id), "declining installs nothing");

    // The agency withdraws a fresh offer before it is answered.
    const t2 = await publishToClients(agAdm, "mission_template", TEMPLATE.id, [CLIENT]);
    await assert.rejects(revokePublication(clAdm, t2.published[0]!), /No open offer/, "the client can't withdraw it");
    await revokePublication(agAdm, t2.published[0]!);
    await assert.rejects(decidePublication(clAdm, t2.published[0]!, "accept"), /already revoked/);
    // The agency can't answer its own offer.
    const t3 = await publishToClients(agAdm, "mission_template", TEMPLATE.id, [CLIENT]);
    await assert.rejects(decidePublication(agAdm, t3.published[0]!, "accept"), /Offer not found/);

    const audits = await prisma.fileChangeLog.findMany({ where: { workspaceId: { in: [AGENCY, CLIENT] }, action: { in: ["store_item_published", "store_publication_accepted", "store_publication_declined"] } } });
    assert.ok(audits.some((x) => x.action === "store_item_published" && x.workspaceId === AGENCY));
    assert.equal(audits.filter((x) => x.action === "store_publication_accepted").length, 2);
    assert.equal(audits.filter((x) => x.action === "store_publication_declined").length, 1);
  });

  it("FORCE RLS: no store rows without a workspace scope; a third workspace sees no one's offers", async () => {
    assert.equal(await countWithoutScope("store_publications"), 0);
    assert.equal(await countWithoutScope("workspace_store_items"), 0);
    const seen = await withWorkspaceScope(OTHER, (tx) => tx.storePublication.count());
    assert.equal(seen, 0);
  });

  it("list_store_items: Tier 0, read-only, this workspace's state", async () => {
    const tool = getTool("list_store_items");
    assert.ok(tool);
    assert.equal(tool!.kind, "safe");
    assert.equal(toolGroup("list_store_items"), "workspace");
    const out = await list_store_items.execute({ projectId: "none", workspaceId: CLIENT, userId: CL_ED, role: "editor", confirmed: false }, { kind: "skill", installed_only: true });
    assert.match(out.summary, new RegExp(`Agency Audit ${RUN}`));
    const none = await list_store_items.execute({ projectId: "none", workspaceId: OTHER, userId: ADM, role: "admin", confirmed: false }, { kind: "skill", installed_only: true });
    assert.match(none.summary, /Nothing in the Store matches/);
  });
});
