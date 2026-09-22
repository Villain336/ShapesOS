// Marketr milestone 21 (part C) — agent-loop skills, routes, grants verification.
//
// Run: npx tsx scripts/verify-m21-routes.mts
// Run 3x green before calling this done.
//
// Part 1 (no DB, no network): static checks over the new route files
//   (force-dynamic, requireUser, no encryptedBlob leaks), migration file,
//   pure authz helpers.
// Part 2 (ephemeral local Postgres 16 + prisma db push): hasPermission /
//   requirePermission matrix, grant CRUD, skill install/enable/disable via
//   the service layer, publicSkill stripping skillMd, load_skill tool
//   (records loadedSkills, truncates to 8000 chars), connector dynamic tool
//   gating (no-binding denial, allow-list denial, declared-tool denial,
//   role gate, confirmation gate, allowed execution), audit rows for every
//   denial, attachment binding through runAgentTurn (mock mode).
//
// No live third-party calls anywhere. No network at all.

import { execSync, spawnSync } from "child_process";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Test-only env before any lib imports.
if (!process.env.MARKETR_CREDENTIALS_KEY) {
  process.env.MARKETR_CREDENTIALS_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL: ${name}`);
  }
}

const ROUTE_FILES = [
  "app/api/skills/route.ts",
  "app/api/skills/registry/route.ts",
  "app/api/skills/preview-url/route.ts",
  "app/api/skills/[id]/route.ts",
  "app/api/skills/[id]/repin/route.ts",
  "app/api/projects/[projectId]/skills/route.ts",
  "app/api/connectors/route.ts",
  "app/api/connectors/mcp/route.ts",
  "app/api/connectors/mcp/[id]/route.ts",
  "app/api/connectors/[key]/auth-url/route.ts",
  "app/api/connectors/[key]/callback/route.ts",
  "app/api/connectors/[key]/api-key/route.ts",
  "app/api/connections/[id]/route.ts",
  "app/api/connections/[id]/refresh/route.ts",
  "app/api/projects/[projectId]/data-sources/route.ts",
  "app/api/projects/[projectId]/data-sources/[bindingId]/route.ts",
  "app/api/projects/[projectId]/files/route.ts",
  "app/api/projects/[projectId]/files/[fileId]/download/route.ts",
  "app/api/projects/[projectId]/files/[fileId]/route.ts",
  "app/api/settings/workspace/route.ts",
  "app/api/projects/[projectId]/settings/route.ts",
  "app/api/settings/audit/route.ts",
  "app/api/members/grants/route.ts",
  "app/api/members/grants/[id]/route.ts",
  "app/api/chat/threads/[id]/messages/route.ts",
];

async function main() {
  console.log("== M21 part C verification ==");

  // ------------------------------------------------------------ part 1
  console.log("-- static route checks --");
  const root = process.cwd();
  for (const f of ROUTE_FILES) {
    const src = readFileSync(join(root, f), "utf8");
    check(`${f}: force-dynamic`, src.includes('export const dynamic = "force-dynamic"'));
    // OAuth callback is state-signed (no session by design) — the one exception.
    if (f !== "app/api/connectors/[key]/callback/route.ts") {
      check(`${f}: requireUser`, src.includes("requireUser()"));
    } else {
      check(`${f}: state-signed, no session (by design)`, src.includes("handleOAuthCallback"));
    }
  }
  const secretLeaks = ROUTE_FILES.filter((f) => {
    const src = readFileSync(join(root, f), "utf8");
    return src.includes("encryptedBlob") || src.includes("getDecryptedCredential");
  });
  check("no route references encryptedBlob / getDecryptedCredential", secretLeaks.length === 0);

  const mig = readFileSync(
    join(root, "prisma/migrations/20260922140000_m21_tool_denied_audit/migration.sql"),
    "utf8",
  );
  check(
    "migration adds connector_tool_denied idempotently",
    mig.includes("ADD VALUE IF NOT EXISTS 'connector_tool_denied'"),
  );
  const schema = readFileSync(join(root, "prisma/schema.prisma"), "utf8");
  check("schema enum has connector_tool_denied", schema.includes("connector_tool_denied"));

  const { roleAtLeast } = await import("@/lib/authz");
  check("roleAtLeast admin>=admin", roleAtLeast("admin", "admin") === true);
  check("roleAtLeast viewer>=editor false", roleAtLeast("viewer", "editor") === false);

  const { getTool } = await import("@/lib/chat/tools");
  const loadSkill = getTool("load_skill");
  check("load_skill registered", !!loadSkill);
  check("load_skill safe/viewer", loadSkill?.kind === "safe" && loadSkill?.minRole === "viewer");

  // ------------------------------------------------------------ part 2
  console.log("-- starting ephemeral postgres --");
  const pgDir = mkdtempSync(join(tmpdir(), "m21cpg-"));
  execSync(`chown postgres:postgres ${pgDir} && chmod 700 ${pgDir}`);
  const port = 55434;
  const sockDir = join(pgDir, "sock");
  const asPostgres = (cmd: string) =>
    execSync(`su postgres -s /bin/sh -c ${JSON.stringify(cmd)}`, { stdio: "pipe" });
  asPostgres(`mkdir -p ${sockDir} && /usr/lib/postgresql/16/bin/initdb -D ${pgDir}/data -E UTF8 >/dev/null 2>&1`);
  const startOut = spawnSync("su", [
    "postgres", "-s", "/bin/sh", "-c",
    `/usr/lib/postgresql/16/bin/pg_ctl -D ${pgDir}/data -o '-k ${sockDir} -p ${port} -c listen_addresses=''' -l ${pgDir}/log start`,
  ]);
  check("postgres started", startOut.status === 0);
  const dbUrl = `postgresql://postgres@localhost:${port}/m21ctest?host=${sockDir}`;
  asPostgres(`psql -h ${sockDir} -p ${port} -U postgres -c "CREATE DATABASE m21ctest;"`);
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    cwd: root,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: "pipe",
  });
  check("prisma db push ok", true);
process.env.DATABASE_URL = dbUrl;

  const { prisma } = await import("@/lib/prisma");
  const { hasPermission, requirePermission } = await import("@/lib/authz");
  const { auditEvent } = await import("@/lib/auditlog");
  const {
    installFromRegistry,
    installFromUpload,
  } = await import("@/lib/skills/importer");
  const {
    getEnabledProjectSkills,
    setProjectSkillEnabled,
    getSkill,
    uninstallSkill,
  } = await import("@/lib/skills/service");
  const { publicSkill } = await import("@/lib/route-utils");
  const { resolveConnectorTool, connectorToolsSection } = await import(
    "@/lib/chat/connector-tools"
  );
  const { runAgentTurn } = await import("@/lib/chat/agent");
  const { skillManifestSection } = await import("@/lib/skills/disclosure");

  // Seed: workspace + project + members of every role.
  await prisma.workspace.create({
    data: { id: "ws-c", name: "C Workspace", ownerUserId: "user-owner" },
  });
  await prisma.project.create({
    data: { id: "proj-c", workspaceId: "ws-c", domain: "example.com" },
  });
  for (const [uid, role] of [
    ["user-admin", "admin"],
    ["user-editor", "editor"],
    ["user-viewer", "viewer"],
  ] as const) {
    await prisma.workspaceMember.create({ data: { workspaceId: "ws-c", userId: uid, role } });
  }

  // ---- permission matrix
  console.log("-- permission grants --");
  check("owner always has skills.install", await hasPermission("user-owner", "ws-c", "skills.install"));
  check("admin always has connectors.connect", await hasPermission("user-admin", "ws-c", "connectors.connect"));
  check("editor without grant: false", (await hasPermission("user-editor", "ws-c", "skills.install")) === false);
  check("viewer without grant: false", (await hasPermission("user-viewer", "ws-c", "skills.install")) === false);
  check("non-member: false", (await hasPermission("user-ghost", "ws-c", "skills.install")) === false);
  check("unknown workspace: false", (await hasPermission("user-owner", "ws-nope", "skills.install")) === false);

  // User grant.
  await prisma.permissionGrant.create({
    data: { workspaceId: "ws-c", userId: "user-editor", permission: "skills.install", grantedBy: "user-owner" },
  });
  check("editor with user grant: true", await hasPermission("user-editor", "ws-c", "skills.install"));
  check("editor still lacks connectors.connect", (await hasPermission("user-editor", "ws-c", "connectors.connect")) === false);
  const rp = await requirePermission("user-editor", "ws-c", "skills.install");
  check("requirePermission returns membership", rp !== null && rp.userId === "user-editor");
  check("requirePermission null without grant", (await requirePermission("user-editor", "ws-c", "connectors.connect")) === null);

  // Role grant.
  await prisma.permissionGrant.create({
    data: { workspaceId: "ws-c", role: "viewer", permission: "connectors.connect", grantedBy: "user-owner" },
  });
  check("viewer with role=viewer grant: true", await hasPermission("user-viewer", "ws-c", "connectors.connect"));
  check("editor covered by role=viewer grant (rank>=)", await hasPermission("user-editor", "ws-c", "connectors.connect"));
  check("role grant does not leak to other permission", (await hasPermission("user-viewer", "ws-c", "skills.install")) === false);
  check("role grant does not leak to other workspace", (await hasPermission("user-viewer", "ws-other", "connectors.connect")) === false);

  // Grant revoke flips it back.
  await prisma.permissionGrant.deleteMany({ where: { workspaceId: "ws-c", userId: "user-editor" } });
  check("revoked user grant: false again", (await hasPermission("user-editor", "ws-c", "skills.install")) === false);

  await auditEvent({
    projectId: null, workspaceId: "ws-c", action: "permission_grant_created",
    summary: "test grant", actorUserId: "user-owner",
  });
  const grantAudit = await prisma.fileChangeLog.findFirst({
    where: { workspaceId: "ws-c", action: "permission_grant_created" },
  });
  check("permission_grant_created audit row", !!grantAudit);

  // ---- skill install / enable / disable
  console.log("-- skills --");
  const regSkill = await installFromRegistry(prisma, "ws-c", "seo-audit", "user-admin");
  check("installFromRegistry ok", regSkill.slug.length > 0 && regSkill.trustTier === "built_in");
  const pub = publicSkill(regSkill);
  check("publicSkill strips skillMd", !("skillMd" in pub) && pub.name === regSkill.name);

  const driveSkillMd = [
    "---",
    "name: Drive Helper",
    "description: Helps with Google Drive files.",
    "version: 1.0.0",
    "tools:",
    "  - google-drive.list_files",
    "---",
    "# Drive Helper",
    "Follow these steps." + "x".repeat(9000),
  ].join("\n");
  const driveSkill = await installFromUpload(prisma, "ws-c", driveSkillMd, "SKILL.md", "user-admin");
  check("installFromUpload ok", driveSkill.declaredTools.includes("google-drive.list_files"));

  await setProjectSkillEnabled(prisma, "proj-c", regSkill.id, true, "user-admin");
  await setProjectSkillEnabled(prisma, "proj-c", driveSkill.id, true, "user-admin");
  const enabled = await getEnabledProjectSkills(prisma, "proj-c");
  check("2 skills enabled", enabled.length === 2);
  await setProjectSkillEnabled(prisma, "proj-c", driveSkill.id, false, "user-admin");
  check("disable → 1 enabled", (await getEnabledProjectSkills(prisma, "proj-c")).length === 1);
  const manifest = skillManifestSection(enabled.map((s) => ({ name: s.name, description: s.description })));
  check("manifest section lists skills", manifest.includes("## AVAILABLE SKILLS"));

  // load_skill tool: records slug + truncates to 8000 chars.
  const ctxBase = {
    projectId: "proj-c", workspaceId: "ws-c", userId: "user-editor",
    role: "editor" as const, confirmed: false, loadedSkills: new Set<string>(),
  };
  const loadRes = await loadSkill!.execute(ctxBase, { slug: driveSkill.slug });
  check("load_skill loads by slug", loadRes.summary.includes("Drive Helper"));
  check("load_skill truncates to 8000", loadRes.summary.length <= 8100);
  check("load_skill records slug", ctxBase.loadedSkills.has(driveSkill.slug));
  let loadMissing = false;
  try {
    await loadSkill!.execute(ctxBase, { slug: "nope" });
  } catch {
    loadMissing = true;
  }
  check("load_skill throws on unknown slug", loadMissing);

  // ---- connector tool gating
  console.log("-- connector tools --");
  const deniedBefore = await prisma.fileChangeLog.count({
    where: { workspaceId: "ws-c", action: "connector_tool_denied" },
  });

  // (a) no binding → explicit denial + audit.
  const noBind = await resolveConnectorTool("connector.resend.get_domain", { ...ctxBase, loadedSkills: new Set() }, {});
  check("no binding → error", noBind.status === "error");
  check("no binding → explicit message", noBind.resultSummary.includes("not connected or not enabled"));

  // (b) allow-list denial.
  await prisma.workspaceSettings.upsert({
    where: { workspaceId: "ws-c" },
    create: { workspaceId: "ws-c", agentAllowList: ["get_keywords"] },
    update: { agentAllowList: ["get_keywords"] },
  });
  const allowDeny = await resolveConnectorTool(
    "connector.resend.get_domain",
    { ...ctxBase, loadedSkills: new Set() },
    {},
  );
  check("allow-list → denied", allowDeny.status === "error" && allowDeny.resultSummary.includes("allow-list"));
  await prisma.workspaceSettings.update({ where: { workspaceId: "ws-c" }, data: { agentAllowList: [] } });

  // (c) bind + allowed execution. NOTE: the connection is created WITHOUT a
  // credential row so the native adapter takes its deterministic mock path
  // (with a credential it would attempt live HTTP). Vault round-trips are
  // covered by verify-m21-connectors.mts.
  const conn = await prisma.connectorConnection.create({
    data: {
      connectorKey: "resend",
      workspaceId: "ws-c",
      userId: "user-editor",
      status: "active",
      scopes: [],
    },
  });
  await prisma.projectDataSource.create({
    data: { projectId: "proj-c", connectionId: conn.id, connectorKey: "resend", createdBy: "user-editor" },
  });
  const section = await connectorToolsSection("proj-c");
  check("prompt section lists connector.resend.get_domain", section.includes("connector.resend.get_domain"));
  const allowed = await resolveConnectorTool(
    "connector.resend.get_domain",
    { ...ctxBase, loadedSkills: new Set() },
    { domainId: "d1" },
  );
  check("bound tool executes", allowed.status === "executed" && allowed.resultSummary.includes("pending"));

  // (d) declared-tool gating: skill declares google-drive tools only.
  const gatedCtx = { ...ctxBase, loadedSkills: new Set<string>([driveSkill.slug]) };
  const gated = await resolveConnectorTool("connector.resend.get_domain", gatedCtx, {});
  check("undeclared tool → denied", gated.status === "error");
  check(
    "undeclared tool → explicit message",
    gated.resultSummary.includes('does not declare tool "get_domain"'),
  );

  // (e) confirmation gate for mutating tools.
  const propose = await resolveConnectorTool(
    "connector.resend.send_test_email",
    { ...ctxBase, loadedSkills: new Set() },
    { to: "a@b.c", subject: "hi" },
  );
  check("mutating → pending_confirmation", propose.status === "pending_confirmation");
  const confirmedExec = await resolveConnectorTool(
    "connector.resend.send_test_email",
    { ...ctxBase, confirmed: true, loadedSkills: new Set() },
    { to: "a@b.c", subject: "hi" },
  );
  check("mutating executes after confirm", confirmedExec.status === "executed");

  // (f) role gate.
  const viewerCtx = { ...ctxBase, role: "viewer" as const, loadedSkills: new Set<string>() };
  const roleDenied = await resolveConnectorTool("connector.resend.send_test_email", viewerCtx, {});
  check("viewer + mutating → skipped_role", roleDenied.status === "skipped_role");
  const viewerRead = await resolveConnectorTool("connector.resend.get_domain", viewerCtx, {});
  check("viewer + read → executed", viewerRead.status === "executed");

  // (g) unknown tool → error listing available tools.
  const unknown = await resolveConnectorTool(
    "connector.resend.nope_tool",
    { ...ctxBase, loadedSkills: new Set() },
    {},
  );
  check("unknown tool → error with list", unknown.status === "error" && unknown.resultSummary.includes("connector.resend.get_domain"));

  // malformed name
  const malformed = await resolveConnectorTool("connector.broken", { ...ctxBase, loadedSkills: new Set() }, {});
  check("malformed name → error", malformed.status === "error");

  const deniedAfter = await prisma.fileChangeLog.count({
    where: { workspaceId: "ws-c", action: "connector_tool_denied" },
  });
  check("denials audited (>=5)", deniedAfter - deniedBefore >= 5);
  const execAudit = await prisma.fileChangeLog.count({
    where: { workspaceId: "ws-c", action: { in: ["ai_proposal", "ai_applied"] } },
  });
  check("executions audited", execAudit >= 2);

  // uninstall flow
  await uninstallSkill(prisma, "ws-c", driveSkill.id, "user-admin");
  check("uninstall removes skill", (await getSkill(prisma, "ws-c", driveSkill.id)) === null);

  // ---- attachments via runAgentTurn (mock mode) ----
  console.log("-- attachments --");
  const attachDir = join(root, ".data", "attachments", "proj-c");
  mkdirSync(attachDir, { recursive: true });
  const attachPath = join(attachDir, "t1-brief.txt");
  writeFileSync(attachPath, "Q3 brief: focus on espresso machines.\n".repeat(50));
  const attach = await prisma.fileAttachment.create({
    data: {
      projectId: "proj-c",
      source: "upload",
      filename: "brief.txt",
      mimeType: "text/plain",
      sizeBytes: 2000,
      storagePath: ".data/attachments/proj-c/t1-brief.txt",
      uploadedBy: "user-editor",
    },
  });
  const thread = await prisma.aiChatThread.create({
    data: { projectId: "proj-c", userId: "user-editor", title: "New chat" },
  });
  const turn = await runAgentTurn({
    projectId: "proj-c",
    workspaceId: "ws-c",
    userId: "user-editor",
    role: "editor",
    threadId: thread.id,
    userContent: "/help",
    attachmentIds: [attach.id],
  });
  check("mock turn returns text", turn.assistantText.includes("Slash commands"));
  const bound = await prisma.fileAttachment.findUnique({ where: { id: attach.id } });
  check("attachment bound to thread session", bound?.sessionId === thread.id);

  // cleanup attachment scratch
  await prisma.fileAttachment.delete({ where: { id: attach.id } });
  rmSync(join(root, ".data", "attachments", "proj-c"), { recursive: true, force: true });

  // ---- teardown
  await prisma.$disconnect();
  spawnSync("su", ["postgres", "-s", "/bin/sh", "-c", `/usr/lib/postgresql/16/bin/pg_ctl -D ${pgDir}/data stop >/dev/null 2>&1`]);
  rmSync(pgDir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("Failures:", failures.join("; "));
    process.exit(1);
  }
  console.log("M21 part C: ALL GREEN");
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
