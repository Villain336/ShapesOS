// ShapesOS — Phase 18.2 (WS=content): the Store (server).
//
//   loadStoreCatalogue   every installable thing, from its own registry, with
//                        this workspace's state (lib/store/catalogue.ts)
//   installStoreItem /   through each kind's EXISTING path, with that path's
//   removeStoreItem      own permission check:
//       skill             installFromRegistry / uninstallSkill (lib/skills) —
//                         admin+ or the skills.install grant, like /api/skills
//       mini_app          publishApp / unpublishApp (lib/apps) — admin+
//       composio_toolkit  setToolkitEnabled (lib/integrations/actions) — editor+
//       mission_template  shown in / removed from the mission picker
//                         (workspace_store_items; templates have no other
//                         install state) — admin+
//       connector,        need credentials only their connect flow collects:
//       mcp_server        the Store links to Settings → Connectors
//   publishToClients /   agency publishing: an Agency-plan workspace's admin
//   decidePublication    offers a mini-app, skill or template to the client
//                        workspaces that spend its credit pool (the existing
//                        agency ↔ client link, Workspace.creditPoolOwnerId);
//                        a client ADMIN accepts (it is then installed in the
//                        client workspace through the same paths) or declines.
// No payments, no marketplace. Every install / remove / publish / decision is
// audited (store_item_* / store_publication_*).

import type { Prisma, WorkspaceRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { hasPermission, roleAtLeast } from "@/lib/authz";
import { auditEvent } from "@/lib/auditlog";
import { BadRequestError, ConflictError, ForbiddenError, HttpError, NotFoundError } from "@/lib/api/errors";
import { listRegistryPacks, getRegistryPack } from "@/lib/skills/registry";
import { installFromRegistry, installFromUpload, SkillImportError } from "@/lib/skills/importer";
import { uninstallSkill, SkillServiceError } from "@/lib/skills/service";
import { MISSION_TEMPLATES, BUSINESS_TYPE_LABELS } from "@/lib/missions/templates";
import { AppError, createApp, publishApp, unpublishApp } from "@/lib/apps/service";
import { effectiveActionTier, parseSpec, type MiniAppSpec } from "@/lib/apps/spec";
import { listBuiltinConnectors, resolveAdapter, isBuiltinKey } from "@/lib/connectors/m21/registry";
import { readOnlyToolsFromConfig } from "@/lib/connectors/m21";
import { mcpToolPolicies } from "@/lib/connectors/m21/mcp-policy";
import { connectorAction } from "@/lib/agents/grants";
import { NEVER_AUTO_ACTIONS } from "@/lib/automation/policy";
import { getTool, toolAction } from "@/lib/chat/tools";
import {
  agentToolTier,
  connectorItems,
  connectorToolTier,
  mcpItems,
  miniAppItems,
  PUBLISHABLE_KINDS,
  skillItems,
  sortCatalogue,
  STORE_KINDS,
  templateItems,
  toolkitItems,
  type StoreItem,
  type StoreKind,
  type StoreTool,
} from "./catalogue";

export interface StoreActor {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

export interface StoreCatalogue {
  items: StoreItem[];
  /** A registry that couldn't be read right now (e.g. Composio unreachable): its kind and why. */
  unavailable: Array<{ kind: StoreKind; reason: string }>;
}

function isStoreKind(k: unknown): k is StoreKind {
  return typeof k === "string" && (STORE_KINDS as readonly string[]).includes(k);
}

export function parseStoreKind(k: unknown): StoreKind {
  if (!isStoreKind(k)) throw new BadRequestError(`kind must be one of ${STORE_KINDS.join(", ")}.`);
  return k;
}

/** A skill's declared tool ("connector.tool" or an agent tool) → its tier, or null when unknown. */
export function resolveDeclaredTool(declared: string): StoreTool | null {
  const dot = declared.indexOf(".");
  if (dot > 0) {
    const key = declared.slice(0, dot);
    const name = declared.slice(dot + 1);
    if (isBuiltinKey(key)) {
      const def = resolveAdapter(key).listTools().find((t) => t.name === name);
      if (def) {
        const t = connectorToolTier(def, def.mutating ? connectorAction(key, name) : null, { neverAuto: NEVER_AUTO_ACTIONS });
        return { ...t, name: declared };
      }
    }
  }
  const agent = getTool(declared) ?? (dot > 0 ? getTool(declared.slice(dot + 1)) : undefined);
  if (agent) return { ...agentToolTier(agent, toolAction(agent.name), NEVER_AUTO_ACTIONS), name: declared };
  return null;
}

/**
 * A built-in connector's tools at their tiers. A money connector's unmapped
 * write is "money_connector_write" (lib/agents/grants.ts) — Tier 3 through
 * evaluateTier itself, like at run time.
 */
export function builtinConnectorTools(key: string): StoreTool[] {
  try {
    return resolveAdapter(key)
      .listTools()
      .map((def) => {
        const action = def.mutating ? connectorAction(key, def.name) : null;
        return connectorToolTier(def, action, { neverAuto: NEVER_AUTO_ACTIONS });
      });
  } catch {
    return [];
  }
}

async function agencyInstalled(workspaceId: string): Promise<Map<StoreKind, Set<string>>> {
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.workspaceStoreItem.findMany({ where: { workspaceId, source: "agency", state: "installed" }, select: { kind: true, itemKey: true } }),
  );
  const out = new Map<StoreKind, Set<string>>();
  for (const r of rows) {
    if (!isStoreKind(r.kind)) continue;
    const set = out.get(r.kind) ?? new Set<string>();
    set.add(r.itemKey);
    out.set(r.kind, set);
  }
  return out;
}

export async function loadStoreCatalogue(actor: StoreActor): Promise<StoreCatalogue> {
  const ws = actor.workspaceId;
  const unavailable: StoreCatalogue["unavailable"] = [];
  const editor = roleAtLeast(actor.role, "editor");
  const [skills, removedTemplates, apps, mcpRows, connCounts, agency] = await Promise.all([
    prisma.skill.findMany({ where: { workspaceId: ws }, select: { id: true, name: true, description: true, version: true, source: true, sourceRef: true, declaredTools: true } }),
    withWorkspaceScope(ws, (tx) => tx.workspaceStoreItem.findMany({ where: { workspaceId: ws, kind: "mission_template", state: "removed" }, select: { itemKey: true } })),
    withWorkspaceScope(ws, (tx) =>
      tx.miniApp.findMany({
        where: { workspaceId: ws, ...(editor ? {} : { published: true }) },
        orderBy: { updatedAt: "desc" },
        take: 200,
        select: { slug: true, name: true, description: true, version: true, published: true, spec: true, draftSpec: true },
      }),
    ),
    prisma.connector.findMany({ where: { workspaceId: ws, kind: "mcp" }, select: { id: true, key: true, displayName: true, config: true, mcpEndpoint: true } }),
    prisma.connectorConnection.groupBy({ by: ["connectorKey"], where: { workspaceId: ws, status: "active" }, _count: { _all: true } }),
    agencyInstalled(ws),
  ]);
  const connectionsBy = new Map(connCounts.map((c) => [c.connectorKey, c._count._all]));

  const items: StoreItem[] = [];
  items.push(
    ...skillItems(
      listRegistryPacks(),
      skills.map((s) => ({ ...s, source: s.source as "registry" | "url" | "upload" })),
      resolveDeclaredTool,
      new Set([...(agency.get("skill") ?? [])].map((k) => k.replace(/^installed:/, ""))),
    ),
  );
  items.push(
    ...templateItems(
      MISSION_TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, businessTypeLabel: BUSINESS_TYPE_LABELS[t.businessType], plan: t.plan, budgetDefaults: t.budgetDefaults })),
      new Set(removedTemplates.map((r) => r.itemKey)),
      agency.get("mission_template") ?? new Set(),
    ),
  );
  items.push(
    ...miniAppItems(
      apps.map((a) => {
        const spec = (a.spec ?? a.draftSpec) as MiniAppSpec | null;
        return {
          slug: a.slug,
          name: a.name,
          description: a.description,
          version: a.version,
          published: a.published,
          entities: (spec?.entities ?? []).map((e) => e.labelPlural ?? e.label),
          actions: (spec?.actions ?? []).map((x) => ({
            key: x.key,
            label: x.label,
            description: x.description,
            tier: effectiveActionTier(x, { toolKind: x.tool ? (getTool(x.tool)?.kind ?? null) : null }),
          })),
        };
      }),
      agency.get("mini_app") ?? new Set(),
    ),
  );
  try {
    const { listDirectory } = await import("@/lib/integrations/actions/toolkits");
    items.push(...toolkitItems(await listDirectory(ws)));
  } catch (err) {
    unavailable.push({ kind: "composio_toolkit", reason: err instanceof Error ? err.message.slice(0, 200) : "unavailable" });
  }
  items.push(
    ...connectorItems(
      listBuiltinConnectors().map((c) => ({
        key: c.key,
        displayName: c.displayName,
        description: c.description,
        authType: c.authType,
        scopes: c.oauth?.scopes ?? [],
        platformKeyEnv: c.platformKey?.envVar ?? null,
        tools: builtinConnectorTools(c.key),
        connections: connectionsBy.get(c.key) ?? 0,
      })),
    ),
  );
  items.push(
    ...mcpItems(
      mcpRows.map((m) => {
        const readOnly = readOnlyToolsFromConfig(m.config);
        const policies = mcpToolPolicies(m.config);
        const tools: StoreTool[] = [
          ...readOnly.map((name) => connectorToolTier({ name, description: "", mutating: false }, null)),
          ...Object.entries(policies)
            .filter(([name]) => !readOnly.includes(name))
            .map(([name, p]) => connectorToolTier({ name, description: "", mutating: true }, p.action, { neverAuto: NEVER_AUTO_ACTIONS })),
        ];
        const cfg = (m.config ?? {}) as { endpoint?: unknown };
        return {
          id: m.id,
          key: m.key,
          displayName: m.displayName,
          endpoint: m.mcpEndpoint ?? (typeof cfg.endpoint === "string" ? cfg.endpoint : null),
          tools,
          connections: connectionsBy.get(m.key) ?? 0,
        };
      }),
    ),
  );
  // Phase 18.3 (WS=trust): show when agents may not use a connector's app.
  const { getAgentBlockedGroups } = await import("@/lib/agents/app-permissions");
  const { connectorGroup } = await import("@/lib/agents/grants");
  const blocked = new Set<string>(await getAgentBlockedGroups(ws));
  for (const item of items) {
    if (item.kind !== "connector") continue;
    const group = connectorGroup(item.key);
    item.agentAccess = { group, blocked: blocked.has(group) };
  }
  return { items: sortCatalogue(items), unavailable };
}

// ---------------------------------------------------------------------------
// Install / remove
// ---------------------------------------------------------------------------

function fromAppError(err: unknown): never {
  if (err instanceof AppError) throw new HttpError(err.status, err.message);
  if (err instanceof SkillImportError) throw new BadRequestError(err.message);
  if (err instanceof SkillServiceError) throw new NotFoundError(err.message);
  throw err;
}

async function requireSkillsInstall(actor: StoreActor): Promise<void> {
  if (!(await hasPermission(actor.userId, actor.workspaceId, "skills.install"))) {
    throw new ForbiddenError("Installing skills needs an admin or the skills.install permission.");
  }
}

function requireRole(actor: StoreActor, min: "editor" | "admin", what: string): void {
  if (!roleAtLeast(actor.role, min)) throw new ForbiddenError(`${what} needs the ${min} role.`);
}

function linkOnly(kind: StoreKind): never {
  throw new BadRequestError(
    kind === "mcp_server"
      ? "Custom MCP servers are added and removed in Settings → Connectors (they need an endpoint and credentials)."
      : "Connectors are connected and disconnected in Settings → Connectors (they need your account or an API key).",
  );
}

async function setStoreRow(
  actor: StoreActor,
  kind: StoreKind,
  itemKey: string,
  state: "installed" | "removed",
  source: "builtin" | "agency" = "builtin",
  publicationId: string | null = null,
): Promise<void> {
  await withWorkspaceScope(actor.workspaceId, (tx) =>
    tx.workspaceStoreItem.upsert({
      where: { workspaceId_kind_itemKey: { workspaceId: actor.workspaceId, kind, itemKey } },
      create: { workspaceId: actor.workspaceId, kind, itemKey, state, source, publicationId, updatedBy: actor.userId },
      update: { state, updatedBy: actor.userId, ...(source === "agency" ? { source, publicationId } : {}) },
    }),
  );
}

async function storeAudit(actor: StoreActor, action: "store_item_installed" | "store_item_removed", kind: StoreKind, key: string, name: string) {
  await auditEvent({
    workspaceId: actor.workspaceId,
    projectId: null,
    action,
    summary: `Store: ${action === "store_item_installed" ? "installed" : "removed"} ${kind.replace(/_/g, " ")} "${name}" (${key})`,
    actorUserId: actor.userId,
  }).catch(() => undefined);
}

export interface InstallResult {
  kind: StoreKind;
  key: string;
  installed: boolean;
}

/**
 * Install one catalogue item through its kind's existing path. The caller
 * has shown the item's tools, tiers and permissions and the person
 * confirmed (`confirmed: true` — the route refuses without it).
 */
export async function installStoreItem(actor: StoreActor, kindIn: unknown, keyIn: unknown): Promise<InstallResult> {
  const kind = parseStoreKind(kindIn);
  const key = typeof keyIn === "string" ? keyIn.trim().slice(0, 120) : "";
  if (!key) throw new BadRequestError("key is required.");
  if (kind === "connector" || kind === "mcp_server") linkOnly(kind);
  if (kind === "skill") {
    await requireSkillsInstall(actor);
    const pack = getRegistryPack(key);
    if (!pack) throw new NotFoundError(key.startsWith("installed:") ? "That skill is already installed." : `No skill pack "${key}".`);
    const existing = await prisma.skill.findFirst({ where: { workspaceId: actor.workspaceId, source: "registry", sourceRef: key }, select: { id: true } });
    if (existing) throw new ConflictError(`${pack.name} is already installed.`);
    const skill = await installFromRegistry(prisma, actor.workspaceId, key, actor.userId).catch(fromAppError);
    // The same audit row the skills route writes, plus the Store's own.
    await auditEvent({ projectId: null, workspaceId: actor.workspaceId, action: "skill_installed", summary: `Installed skill "${skill.name}" (source=registry, from the Store)`, actorUserId: actor.userId }).catch(() => undefined);
    await storeAudit(actor, "store_item_installed", kind, key, skill.name);
    return { kind, key, installed: true };
  }
  if (kind === "mission_template") {
    requireRole(actor, "admin", "Adding a mission template");
    const t = MISSION_TEMPLATES.find((x) => x.id === key);
    if (!t) throw new NotFoundError(`No mission template "${key}".`);
    await setStoreRow(actor, kind, key, "installed");
    await storeAudit(actor, "store_item_installed", kind, key, t.name);
    return { kind, key, installed: true };
  }
  if (kind === "mini_app") {
    await publishApp({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, key).catch(fromAppError);
    await storeAudit(actor, "store_item_installed", kind, key, key);
    return { kind, key, installed: true };
  }
  // composio_toolkit
  requireRole(actor, "editor", "Enabling a toolkit");
  const { setToolkitEnabled } = await import("@/lib/integrations/actions/toolkits");
  await setToolkitEnabled({ workspaceId: actor.workspaceId, toolkitSlug: key, enabled: true, userId: actor.userId });
  await storeAudit(actor, "store_item_installed", kind, key, key);
  return { kind, key, installed: true };
}

export async function removeStoreItem(actor: StoreActor, kindIn: unknown, keyIn: unknown): Promise<InstallResult> {
  const kind = parseStoreKind(kindIn);
  const key = typeof keyIn === "string" ? keyIn.trim().slice(0, 120) : "";
  if (!key) throw new BadRequestError("key is required.");
  if (kind === "connector" || kind === "mcp_server") linkOnly(kind);
  if (kind === "skill") {
    await requireSkillsInstall(actor);
    const row = key.startsWith("installed:")
      ? await prisma.skill.findFirst({ where: { workspaceId: actor.workspaceId, id: key.slice("installed:".length) }, select: { id: true } })
      : await prisma.skill.findFirst({ where: { workspaceId: actor.workspaceId, source: "registry", sourceRef: key }, select: { id: true } });
    if (!row) throw new NotFoundError("That skill isn't installed.");
    const skill = await uninstallSkill(prisma, actor.workspaceId, row.id, actor.userId).catch(fromAppError);
    await auditEvent({ projectId: null, workspaceId: actor.workspaceId, action: "skill_uninstalled", summary: `Uninstalled skill "${skill.name}" (from the Store)`, actorUserId: actor.userId }).catch(() => undefined);
    await withWorkspaceScope(actor.workspaceId, (tx) =>
      tx.workspaceStoreItem.updateMany({ where: { workspaceId: actor.workspaceId, kind: "skill", itemKey: `installed:${row.id}` }, data: { state: "removed", updatedBy: actor.userId } }),
    );
    await storeAudit(actor, "store_item_removed", kind, key, skill.name);
    return { kind, key, installed: false };
  }
  if (kind === "mission_template") {
    requireRole(actor, "admin", "Removing a mission template");
    const t = MISSION_TEMPLATES.find((x) => x.id === key);
    if (!t) throw new NotFoundError(`No mission template "${key}".`);
    await setStoreRow(actor, kind, key, "removed");
    await storeAudit(actor, "store_item_removed", kind, key, t.name);
    return { kind, key, installed: false };
  }
  if (kind === "mini_app") {
    await unpublishApp({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, key).catch(fromAppError);
    await storeAudit(actor, "store_item_removed", kind, key, key);
    return { kind, key, installed: false };
  }
  requireRole(actor, "editor", "Turning a toolkit off");
  const { setToolkitEnabled } = await import("@/lib/integrations/actions/toolkits");
  await setToolkitEnabled({ workspaceId: actor.workspaceId, toolkitSlug: key, enabled: false, userId: actor.userId });
  await storeAudit(actor, "store_item_removed", kind, key, key);
  return { kind, key, installed: false };
}

export { removedMissionTemplates } from "./state";

// ---------------------------------------------------------------------------
// Agency publishing
// ---------------------------------------------------------------------------

export interface ClientWorkspace {
  id: string;
  name: string;
}

/** The client workspaces linked to this agency (they spend its credit pool). Empty unless it is an Agency-plan workspace. */
export async function listClientWorkspaces(agencyWorkspaceId: string): Promise<ClientWorkspace[]> {
  const agency = await prisma.workspace.findUnique({ where: { id: agencyWorkspaceId }, select: { plan: true, creditPoolOwnerId: true } });
  if (!agency || agency.plan !== "agency" || agency.creditPoolOwnerId) return [];
  return prisma.workspace.findMany({ where: { creditPoolOwnerId: agencyWorkspaceId }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 500 });
}

export interface PublicationOut {
  id: string;
  kind: StoreKind;
  itemKey: string;
  title: string;
  status: string;
  /** The other party's workspace name (the client for the agency; the agency for the client). */
  party: string;
  partyWorkspaceId: string;
  createdAt: string;
  decidedAt: string | null;
}

type PublishPayload =
  | { kind: "skill"; source: "registry"; packKey: string }
  | { kind: "skill"; source: "upload"; skillMd: string; filename: string }
  | { kind: "mini_app"; spec: MiniAppSpec }
  | { kind: "mission_template"; templateId: string };

async function buildPayload(actor: StoreActor, kind: StoreKind, key: string): Promise<{ payload: PublishPayload; title: string }> {
  if (kind === "skill") {
    const pack = getRegistryPack(key);
    if (pack) return { payload: { kind, source: "registry", packKey: pack.key }, title: pack.name };
    const id = key.replace(/^installed:/, "");
    const s = await prisma.skill.findFirst({ where: { workspaceId: actor.workspaceId, id }, select: { name: true, slug: true, skillMd: true } });
    if (!s) throw new NotFoundError("That skill isn't installed in this workspace.");
    return { payload: { kind, source: "upload", skillMd: s.skillMd, filename: `${s.slug}.md` }, title: s.name };
  }
  if (kind === "mini_app") {
    const row = await withWorkspaceScope(actor.workspaceId, (tx) =>
      tx.miniApp.findFirst({ where: { workspaceId: actor.workspaceId, slug: key }, select: { name: true, spec: true, published: true } }),
    );
    if (!row || !row.published || !row.spec) throw new BadRequestError("Publish the app in this workspace first; clients get its live version.");
    const parsed = parseSpec(row.spec);
    if (!parsed.ok) throw new BadRequestError(`The app's spec is not valid: ${parsed.errors[0]}`);
    return { payload: { kind, spec: parsed.spec }, title: row.name };
  }
  if (kind === "mission_template") {
    const t = MISSION_TEMPLATES.find((x) => x.id === key);
    if (!t) throw new NotFoundError(`No mission template "${key}".`);
    return { payload: { kind, templateId: t.id }, title: t.name };
  }
  throw new BadRequestError("Only mini-apps, skills and mission templates can be published to clients.");
}

/**
 * Offer an item to some of this agency's client workspaces (admin+ of the
 * agency). One pending publication per client and item: offering it again
 * refreshes the pending offer instead of stacking another.
 */
export async function publishToClients(actor: StoreActor, kindIn: unknown, keyIn: unknown, clientIds: unknown): Promise<{ published: string[] }> {
  requireRole(actor, "admin", "Publishing to client workspaces");
  const kind = parseStoreKind(kindIn);
  if (!PUBLISHABLE_KINDS.includes(kind)) throw new BadRequestError("Only mini-apps, skills and mission templates can be published to clients.");
  const key = typeof keyIn === "string" ? keyIn.trim().slice(0, 120) : "";
  if (!key) throw new BadRequestError("key is required.");
  const wanted = Array.isArray(clientIds) ? [...new Set(clientIds.filter((x): x is string => typeof x === "string"))].slice(0, 200) : [];
  if (wanted.length === 0) throw new BadRequestError("Pick at least one client workspace.");
  const clients = await listClientWorkspaces(actor.workspaceId);
  if (clients.length === 0) throw new ForbiddenError("Only an Agency-plan workspace with client workspaces can publish to clients.");
  const allowed = new Set(clients.map((c) => c.id));
  const foreign = wanted.filter((id) => !allowed.has(id));
  if (foreign.length) throw new ForbiddenError("Some of those workspaces aren't your clients.");
  const { payload, title } = await buildPayload(actor, kind, key);
  const published: string[] = [];
  for (const clientId of wanted) {
    const id = await withWorkspaceScope(actor.workspaceId, async (tx) => {
      const pending = await tx.storePublication.findFirst({
        where: { workspaceId: clientId, agencyWorkspaceId: actor.workspaceId, kind, itemKey: key, status: "pending" },
        select: { id: true },
      });
      if (pending) {
        await tx.storePublication.update({
          where: { id: pending.id, agencyWorkspaceId: actor.workspaceId },
          data: { payload: payload as unknown as Prisma.InputJsonValue, title, publishedBy: actor.userId },
        });
        return pending.id;
      }
      const row = await tx.storePublication.create({
        data: { workspaceId: clientId, agencyWorkspaceId: actor.workspaceId, kind, itemKey: key, title, payload: payload as unknown as Prisma.InputJsonValue, publishedBy: actor.userId },
        select: { id: true },
      });
      return row.id;
    });
    published.push(id);
  }
  await auditEvent({
    workspaceId: actor.workspaceId,
    projectId: null,
    action: "store_item_published",
    summary: `Store: offered ${kind.replace(/_/g, " ")} "${title}" to ${wanted.length} client workspace${wanted.length === 1 ? "" : "s"}`,
    actorUserId: actor.userId,
  }).catch(() => undefined);
  return { published };
}

/** Offers to this workspace (incoming) and, for an agency, its offers (outgoing). */
export async function listPublications(actor: StoreActor): Promise<{ incoming: PublicationOut[]; outgoing: PublicationOut[] }> {
  const ws = actor.workspaceId;
  const rows = await withWorkspaceScope(ws, (tx) =>
    tx.storePublication.findMany({
      where: { OR: [{ workspaceId: ws }, { agencyWorkspaceId: ws }] },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { id: true, workspaceId: true, agencyWorkspaceId: true, kind: true, itemKey: true, title: true, status: true, createdAt: true, decidedAt: true },
    }),
  );
  const partyIds = [...new Set(rows.map((r) => (r.workspaceId === ws ? r.agencyWorkspaceId : r.workspaceId)))];
  const names = new Map((await prisma.workspace.findMany({ where: { id: { in: partyIds } }, select: { id: true, name: true } })).map((w) => [w.id, w.name]));
  const out = (r: (typeof rows)[number], partyId: string): PublicationOut => ({
    id: r.id,
    kind: isStoreKind(r.kind) ? r.kind : "skill",
    itemKey: r.itemKey,
    title: r.title,
    status: r.status,
    party: names.get(partyId) ?? partyId,
    partyWorkspaceId: partyId,
    createdAt: r.createdAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
  });
  return {
    incoming: rows.filter((r) => r.workspaceId === ws && r.agencyWorkspaceId !== ws).map((r) => out(r, r.agencyWorkspaceId)),
    outgoing: rows.filter((r) => r.agencyWorkspaceId === ws).map((r) => out(r, r.workspaceId)),
  };
}

/** The client admin's answer. Accept installs the offered item here, through the same paths as the Store. */
export async function decidePublication(actor: StoreActor, id: string, decision: unknown): Promise<{ status: "accepted" | "declined"; installedKey: string | null }> {
  requireRole(actor, "admin", "Accepting or declining an agency's offer");
  if (decision !== "accept" && decision !== "decline") throw new BadRequestError('decision must be "accept" or "decline".');
  const pub = await withWorkspaceScope(actor.workspaceId, (tx) =>
    tx.storePublication.findFirst({ where: { id, workspaceId: actor.workspaceId }, select: { id: true, kind: true, itemKey: true, title: true, status: true, payload: true, agencyWorkspaceId: true } }),
  );
  if (!pub || pub.agencyWorkspaceId === actor.workspaceId) throw new NotFoundError("Offer not found.");
  if (pub.status !== "pending") throw new ConflictError(`This offer was already ${pub.status}.`);
  // Claim it first so two admins can't both install it.
  const claimed = await withWorkspaceScope(actor.workspaceId, (tx) =>
    tx.storePublication.updateMany({
      where: { id: pub.id, workspaceId: actor.workspaceId, status: "pending" },
      data: { status: decision === "accept" ? "accepted" : "declined", decidedBy: actor.userId, decidedAt: new Date() },
    }),
  );
  if (claimed.count !== 1) throw new ConflictError("Someone answered this offer just now.");
  if (decision === "decline") {
    await auditEvent({ workspaceId: actor.workspaceId, projectId: null, action: "store_publication_declined", summary: `Store: declined the agency's "${pub.title}"`, actorUserId: actor.userId }).catch(() => undefined);
    return { status: "declined", installedKey: null };
  }
  let installedKey: string;
  try {
    installedKey = await installPayload(actor, pub.payload as unknown as PublishPayload, pub.id);
  } catch (err) {
    // Nothing was installed: the offer stays open to try again.
    await withWorkspaceScope(actor.workspaceId, (tx) =>
      tx.storePublication.updateMany({ where: { id: pub.id, workspaceId: actor.workspaceId }, data: { status: "pending", decidedBy: null, decidedAt: null } }),
    );
    throw err;
  }
  await auditEvent({ workspaceId: actor.workspaceId, projectId: null, action: "store_publication_accepted", summary: `Store: accepted and installed the agency's "${pub.title}"`, actorUserId: actor.userId }).catch(() => undefined);
  return { status: "accepted", installedKey };
}

async function installPayload(actor: StoreActor, payload: PublishPayload, publicationId: string): Promise<string> {
  const appActor = { workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role };
  if (payload?.kind === "skill") {
    if (payload.source === "registry") {
      const existing = await prisma.skill.findFirst({ where: { workspaceId: actor.workspaceId, source: "registry", sourceRef: payload.packKey }, select: { id: true } });
      const skill = existing ?? (await installFromRegistry(prisma, actor.workspaceId, payload.packKey, actor.userId).catch(fromAppError));
      await setStoreRow(actor, "skill", `installed:${skill.id}`, "installed", "agency", publicationId);
      return payload.packKey;
    }
    const skill = await installFromUpload(prisma, actor.workspaceId, payload.skillMd, payload.filename, actor.userId).catch(fromAppError);
    await auditEvent({ projectId: null, workspaceId: actor.workspaceId, action: "skill_installed", summary: `Installed skill "${skill.name}" (from the agency, via the Store)`, actorUserId: actor.userId }).catch(() => undefined);
    await setStoreRow(actor, "skill", `installed:${skill.id}`, "installed", "agency", publicationId);
    return `installed:${skill.id}`;
  }
  if (payload?.kind === "mini_app") {
    const made = await createApp(appActor, { spec: payload.spec }).catch(fromAppError);
    await publishApp(appActor, made.slug).catch(fromAppError);
    await setStoreRow(actor, "mini_app", made.slug, "installed", "agency", publicationId);
    return made.slug;
  }
  if (payload?.kind === "mission_template") {
    if (!MISSION_TEMPLATES.some((t) => t.id === payload.templateId)) throw new NotFoundError("That mission template no longer exists.");
    await setStoreRow(actor, "mission_template", payload.templateId, "installed", "agency", publicationId);
    return payload.templateId;
  }
  throw new BadRequestError("This offer can't be installed.");
}

/** The agency withdraws an offer the client hasn't answered (admin+ of the agency). */
export async function revokePublication(actor: StoreActor, id: string): Promise<void> {
  requireRole(actor, "admin", "Withdrawing an offer");
  const res = await withWorkspaceScope(actor.workspaceId, (tx) =>
    tx.storePublication.updateMany({ where: { id, agencyWorkspaceId: actor.workspaceId, status: "pending" }, data: { status: "revoked", decidedBy: actor.userId, decidedAt: new Date() } }),
  );
  if (res.count === 0) throw new NotFoundError("No open offer with that id.");
}
