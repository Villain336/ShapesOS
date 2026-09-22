// Marketr milestone 21 — fixture tests for the skills library
// (lib/skills/: frontmatter, registry, importer, disclosure, service).
//
// Run: npx tsx scripts/verify-m21-skills.mts
// No live database, no network: Prisma is faked in-memory and fetch is
// stubbed. Tests: frontmatter valid/invalid cases, registry pack
// round-trips, slug-conflict installs, previewFromUrl with a stub fetch
// (github repo URL → raw resolution; unresolvable SHA → warning, not throw),
// cross-workspace enable rejection, uninstall, disclosure truncation.

import { parseSkillMd } from "@/lib/skills/frontmatter";
import {
  REGISTRY_PACKS,
  getRegistryPack,
  listRegistryPacks,
} from "@/lib/skills/registry";
import {
  SkillImportError,
  installFromRegistry,
  installFromUrl,
  installFromUpload,
  previewFromUrl,
} from "@/lib/skills/importer";
import {
  loadSkillBySlug,
  skillManifestSection,
} from "@/lib/skills/disclosure";
import {
  SkillServiceError,
  getEnabledProjectSkills,
  getSkill,
  listSkills,
  setProjectSkillEnabled,
  uninstallSkill,
} from "@/lib/skills/service";
import type { PrismaClient } from "@prisma/client";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------- fake prisma
type Row = Record<string, unknown>;

interface FakeState {
  skills: Map<string, Row>;
  projectSkills: Map<string, Row>; // key `${projectId}:${skillId}`
  projects: Map<string, Row>;
  seq: number;
}

function newState(): FakeState {
  return { skills: new Map(), projectSkills: new Map(), projects: new Map(), seq: 0 };
}

function matchSkill(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => row[k] === v);
}

function fakeDb(state: FakeState): PrismaClient {
  const bySlug = (workspaceId: string, slug: string) =>
    [...state.skills.values()].find((r) => r.workspaceId === workspaceId && r.slug === slug) ?? null;
  return {
    skill: {
      findFirst: async ({ where }: { where: Row }) =>
        [...state.skills.values()].find((r) => matchSkill(r, where)) ?? null,
      findUnique: async ({ where }: { where: Row }) =>
        (where.id ? (state.skills.get(where.id as string) ?? null) : null),
      findMany: async ({ where, orderBy }: { where?: Row; orderBy?: Row }) => {
        let rows = [...state.skills.values()];
        if (where) rows = rows.filter((r) => matchSkill(r, where));
        if (orderBy && "name" in orderBy)
          rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        return rows;
      },
      create: async ({ data }: { data: Row }) => {
        state.seq += 1;
        const row: Row = { id: `sk-${state.seq}`, installedAt: new Date(), ...data };
        state.skills.set(row.id as string, row);
        return row;
      },
      delete: async ({ where }: { where: Row }) => {
        const row = state.skills.get(where.id as string);
        if (!row) throw new Error("not found");
        state.skills.delete(where.id as string);
        return row;
      },
    },
    project: {
      findUnique: async ({ where }: { where: Row }) =>
        state.projects.get(where.id as string) ?? null,
    },
    projectSkill: {
      deleteMany: async ({ where }: { where: Row }) => {
        let n = 0;
        for (const [k, r] of state.projectSkills) {
          if (matchSkill(r, where)) {
            state.projectSkills.delete(k);
            n += 1;
          }
        }
        return { count: n };
      },
      upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
        const { projectId, skillId } = where.projectId_skillId as Row;
        const key = `${projectId}:${skillId}`;
        const existing = state.projectSkills.get(key);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row: Row = { enabledAt: new Date(), ...create };
        state.projectSkills.set(key, row);
        return row;
      },
      findMany: async ({ where, include, orderBy }: { where?: Row; include?: Row; orderBy?: Row }) => {
        let rows = [...state.projectSkills.values()];
        if (where) rows = rows.filter((r) => matchSkill(r, where));
        if (include && (include as Row).skill) {
          rows = rows.map((r) => ({ ...r, skill: state.skills.get(r.skillId as string) ?? null }));
        }
        if (orderBy && (orderBy as Row).skill) {
          rows.sort((a, b) => String((a.skill as Row)?.name ?? "").localeCompare(String((b.skill as Row)?.name ?? "")));
        }
        return rows;
      },
    },
  } as unknown as PrismaClient;
}

// ---------------------------------------------------------------- stub fetch
interface StubResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}

const VALID_STUB_MD = `---
name: Stub Skill
description: A stubbed skill fetched from a fake URL.
version: 2.0.0
tools:
  - dataforseo.serp
---

# Stub Skill

Body text for the stubbed skill.
`;

function stubFetchFactory(opts: { apiShaStatus?: number } = {}) {
  const calls: string[] = [];
  const fetchImpl = async (url: string): Promise<StubResponse> => {
    calls.push(url);
    const respond = (status: number, body: string): StubResponse => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async () => JSON.parse(body),
    });
    if (url === "https://raw.githubusercontent.com/acme/seo-skills/main/SKILL.md") {
      return respond(404, "not found");
    }
    if (url === "https://raw.githubusercontent.com/acme/seo-skills/master/SKILL.md") {
      return respond(200, VALID_STUB_MD);
    }
    if (url === "https://api.github.com/repos/acme/seo-skills/commits/master") {
      const status = opts.apiShaStatus ?? 200;
      return respond(status, JSON.stringify({ sha: "deadbeef1234567890" }));
    }
    if (url === "https://cdn.example.com/skills/custom/SKILL.md") {
      return respond(200, VALID_STUB_MD);
    }
    return respond(404, "not found");
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

// ============================================================ frontmatter ===
const GOOD = `---
name: SEO Audit
description: Run a structured technical and content SEO audit.
version: 1.2.0
tools:
  - google-search-console.query
  - dataforseo.on_page
---

# Body

Some guidance here.
`;

{
  const r = parseSkillMd(GOOD);
  check("valid full parses", r.ok === true);
  if (r.ok) {
    check("valid full name", r.value.manifest.name === "SEO Audit");
    check("valid full version", r.value.manifest.version === "1.2.0");
    check(
      "valid full tools",
      JSON.stringify(r.value.manifest.declaredTools) ===
        JSON.stringify(["google-search-console.query", "dataforseo.on_page"]),
    );
    check("valid full body", r.value.body.includes("# Body"));
  }
}
{
  const minimal = `---\nname: Tiny\ndescription: Just a tiny skill.\n---\n\nBody.\n`;
  const r = parseSkillMd(minimal);
  check("valid minimal parses", r.ok === true);
  if (r.ok) {
    check("minimal defaults version", r.value.manifest.version === "1.0.0");
    check("minimal defaults tools", JSON.stringify(r.value.manifest.declaredTools) === "[]");
  }
}
{
  const r = parseSkillMd("name: No fence\ndescription: x\n");
  check(
    "missing fence rejected",
    r.ok === false && r.errors.some((e) => e.includes("no --- fence")),
  );
}
{
  const r = parseSkillMd("---\nname: Unterminated\ndescription: x\n");
  check(
    "unterminated fence rejected",
    r.ok === false && r.errors.some((e) => e.includes("unterminated --- fence")),
  );
}
{
  const r = parseSkillMd("---\ndescription: No name here.\n---\n\nBody.\n");
  check(
    "missing name rejected",
    r.ok === false && r.errors.some((e) => e.includes("field 'name' is required")),
  );
}
{
  const r = parseSkillMd("---\nname: X\ndescription: ''\n---\n\nBody.\n");
  check(
    "empty description rejected",
    r.ok === false && r.errors.some((e) => e.includes("field 'description' is required")),
  );
}
{
  const long = "d".repeat(501);
  const r = parseSkillMd(`---\nname: X\ndescription: ${long}\n---\n\nBody.\n`);
  check(
    "501-char description rejected",
    r.ok === false && r.errors.some((e) => e.includes("500") && e.includes("501")),
  );
}
{
  const exact = "d".repeat(500);
  const r = parseSkillMd(`---\nname: X\ndescription: ${exact}\n---\n\nBody.\n`);
  check("500-char description accepted", r.ok === true);
}
{
  const r = parseSkillMd("---\nname: X\ndescription: Y\ntools: dataforseo.serp\n---\n\nBody.\n");
  check(
    "scalar tools rejected",
    r.ok === false && r.errors.some((e) => e.includes("dash list")),
  );
}
{
  const r = parseSkillMd("---\nname: X\ndescription: Y\ntools:\n  - a\n  - \n---\n\nBody.\n");
  check(
    "empty tool entry rejected",
    r.ok === false && r.errors.some((e) => e.includes("empty entries")),
  );
}
{
  const r = parseSkillMd("---\nname: X\ndescription: Y\ntools: [a, b]\n---\n\nBody.\n");
  check(
    "inline array rejected with guidance",
    r.ok === false && r.errors.some((e) => e.includes("dash list")),
  );
}
{
  const r = parseSkillMd("---\nname: X\ndescription: Y\n---\n");
  check(
    "empty body rejected",
    r.ok === false && r.errors.some((e) => e.includes("body is empty")),
  );
}
{
  const r = parseSkillMd("---\nname: A\nname: B\ndescription: Y\n---\n\nBody.\n");
  check(
    "duplicate field rejected",
    r.ok === false && r.errors.some((e) => e.includes("duplicate field 'name'")),
  );
}
{
  const r = parseSkillMd("");
  check("empty input rejected", r.ok === false);
}

// ============================================================== registry ===
check("registry has 4 packs", REGISTRY_PACKS.length === 4);
check(
  "registry keys",
  JSON.stringify(REGISTRY_PACKS.map((p) => p.key)) ===
    JSON.stringify(["seo-audit", "content-brief", "rank-report", "competitor-watch"]),
);
for (const pack of REGISTRY_PACKS) {
  const r = parseSkillMd(pack.skillMd);
  check(`pack ${pack.key} parses clean`, r.ok === true, r.ok ? "" : (r as { errors: string[] }).errors.join("; "));
  if (r.ok) {
    check(`pack ${pack.key} manifest name matches`, r.value.manifest.name === pack.name);
    check(`pack ${pack.key} manifest version matches`, r.value.manifest.version === pack.version);
    check(
      `pack ${pack.key} tools match`,
      JSON.stringify(r.value.manifest.declaredTools) === JSON.stringify(pack.declaredTools),
    );
    const bodyLines = r.value.body.split("\n").length;
    check(`pack ${pack.key} body 40-90 lines (got ${bodyLines})`, bodyLines >= 40 && bodyLines <= 90);
    check(`pack ${pack.key} description ≤500 chars`, pack.description.length <= 500);
  }
}
{
  const meta = listRegistryPacks();
  check("listRegistryPacks has 4", meta.length === 4);
  check(
    "listRegistryPacks hides bodies",
    meta.every((m) => !("skillMd" in m)),
  );
  check("getRegistryPack finds seo-audit", getRegistryPack("seo-audit")?.name === "SEO Audit");
  check("getRegistryPack unknown → undefined", getRegistryPack("nope") === undefined);
}

// ============================================================== importer ===
{
  // --- slug conflict: install the same pack twice ---
  const state = newState();
  const db = fakeDb(state);
  const first = await installFromRegistry(db, "ws-1", "seo-audit", "user-1");
  const second = await installFromRegistry(db, "ws-1", "seo-audit", "user-1");
  check("first install slug = seo-audit", (first as Row).slug === "seo-audit");
  check("slug conflict → seo-audit-2", (second as Row).slug === "seo-audit-2");
  check("registry trust tier built_in", (first as Row).trustTier === "built_in");
  check("registry source = registry", (first as Row).source === "registry");
  check("registry sourceRef = pack key", (first as Row).sourceRef === "seo-audit");
  check("registry declaredTools preserved", Array.isArray((first as Row).declaredTools) && ((first as Row).declaredTools as string[]).length === 2);

  let threw = false;
  try {
    await installFromRegistry(db, "ws-1", "nope", "user-1");
  } catch (e) {
    threw = e instanceof SkillImportError && /unknown registry pack/.test((e as Error).message);
  }
  check("unknown pack key throws SkillImportError", threw);

  // --- upload install ---
  const uploaded = await installFromUpload(db, "ws-1", GOOD, "my-skill.md", "user-2");
  check("upload slug from filename", (uploaded as Row).slug === "my-skill");
  check("upload source = upload", (uploaded as Row).source === "upload");
  check("upload trust tier pinned_url", (uploaded as Row).trustTier === "pinned_url");

  let uploadThrew = false;
  try {
    await installFromUpload(db, "ws-1", "no frontmatter here", "bad.md", "user-2");
  } catch (e) {
    uploadThrew = e instanceof SkillImportError && /failed validation/.test((e as Error).message);
  }
  check("invalid upload throws SkillImportError", uploadThrew);
}

{
  // --- previewFromUrl: github repo URL, main 404 → master 200 ---
  const { fetchImpl, calls } = stubFetchFactory();
  const preview = await previewFromUrl("https://github.com/acme/seo-skills", fetchImpl);
  check("github preview name", preview.name === "Stub Skill");
  check("github preview sha pinned", preview.sha === "deadbeef1234567890");
  check("github preview no warnings", preview.warnings.length === 0);
  const mainIdx = calls.indexOf("https://raw.githubusercontent.com/acme/seo-skills/main/SKILL.md");
  const masterIdx = calls.indexOf("https://raw.githubusercontent.com/acme/seo-skills/master/SKILL.md");
  check("main tried before master", mainIdx !== -1 && masterIdx !== -1 && mainIdx < masterIdx);

  // --- unresolvable SHA → warning, not throw ---
  const { fetchImpl: fetchNoSha } = stubFetchFactory({ apiShaStatus: 403 });
  const previewWarn = await previewFromUrl("https://github.com/acme/seo-skills", fetchNoSha);
  check("unresolvable SHA → sha null", previewWarn.sha === null);
  check(
    "unresolvable SHA → warning",
    previewWarn.warnings.some((w) => w.includes("could not resolve commit SHA")),
  );

  // --- installFromUrl records the pin ---
  const state = newState();
  const db = fakeDb(state);
  const installed = await installFromUrl(db, "ws-1", preview, "https://github.com/acme/seo-skills", "user-3");
  check("url install source = url", (installed as Row).source === "url");
  check("url install shaPin recorded", (installed as Row).shaPin === "deadbeef1234567890");
  check("url install trust pinned_url", (installed as Row).trustTier === "pinned_url");
  check("url install sourceRef = url", (installed as Row).sourceRef === "https://github.com/acme/seo-skills");

  // --- direct raw URL ---
  const { fetchImpl: fetchRaw } = stubFetchFactory();
  const rawPreview = await previewFromUrl("https://cdn.example.com/skills/custom/SKILL.md", fetchRaw);
  check("raw url preview name", rawPreview.name === "Stub Skill");
  check("raw url sha null", rawPreview.sha === null);
  check(
    "raw url warns about unpinned",
    rawPreview.warnings.some((w) => w.includes("unpinned")),
  );

  // --- invalid inputs throw ---
  let badUrl = false;
  try {
    await previewFromUrl("not a url", stubFetchFactory().fetchImpl);
  } catch (e) {
    badUrl = e instanceof SkillImportError;
  }
  check("malformed URL throws SkillImportError", badUrl);

  let blobUrl = false;
  try {
    await previewFromUrl("https://github.com/acme/seo-skills/blob/main/SKILL.md", stubFetchFactory().fetchImpl);
  } catch (e) {
    blobUrl = e instanceof SkillImportError && /repository-root/.test((e as Error).message);
  }
  check("github blob URL rejected with guidance", blobUrl);

  let wrongExt = false;
  try {
    await previewFromUrl("https://example.com/skills/readme.txt", stubFetchFactory().fetchImpl);
  } catch (e) {
    wrongExt = e instanceof SkillImportError && /SKILL.md/.test((e as Error).message);
  }
  check("non-SKILL.md URL rejected", wrongExt);
}

// ============================================================= disclosure ===
{
  const longDesc = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
  const section = skillManifestSection([
    { name: "SEO Audit", description: longDesc },
    { name: "Content Brief", description: "Short description." },
  ]);
  check("section header", section.startsWith("## AVAILABLE SKILLS"));
  const auditLine = section.split("\n").find((l) => l.startsWith("SEO Audit:"));
  check(
    "long description truncated to 60 words",
    auditLine !== undefined && auditLine.split(/\s+/).length - 2 <= 61 && auditLine.endsWith("…"),
  );
  check("short description untouched", section.includes("Content Brief: Short description."));
  check("empty list handled", skillManifestSection([]).includes("No skills are installed"));
}
{
  const state = newState();
  const db = fakeDb(state);
  const installed = await installFromRegistry(db, "ws-1", "rank-report", "user-1");
  const md = await loadSkillBySlug(db, "ws-1", (installed as Row).slug as string);
  check("loadSkillBySlug returns skillMd", typeof md === "string" && md.includes("Rank Report"));
  check("loadSkillBySlug missing → null", (await loadSkillBySlug(db, "ws-1", "nope")) === null);
  check("loadSkillBySlug other workspace → null", (await loadSkillBySlug(db, "ws-2", "rank-report")) === null);
}

// ================================================================ service ===
{
  const state = newState();
  state.projects.set("proj-a", { id: "proj-a", workspaceId: "ws-a" });
  state.projects.set("proj-b", { id: "proj-b", workspaceId: "ws-b" });
  const db = fakeDb(state);
  const skillA = await installFromRegistry(db, "ws-a", "seo-audit", "u1");
  await installFromRegistry(db, "ws-a", "content-brief", "u1");

  // Cross-workspace bind rejected.
  let crossThrew = false;
  try {
    await setProjectSkillEnabled(db, "proj-b", (skillA as Row).id as string, true, "u1");
  } catch (e) {
    crossThrew =
      e instanceof SkillServiceError && /cross-workspace/.test((e as Error).message);
  }
  check("cross-workspace enable rejected", crossThrew);

  // Same-workspace enable works.
  await setProjectSkillEnabled(db, "proj-a", (skillA as Row).id as string, true, "u1");
  const enabled = await getEnabledProjectSkills(db, "proj-a");
  check("enabled skill listed", enabled.length === 1 && enabled[0].name === "SEO Audit");

  // Disable → no longer listed.
  await setProjectSkillEnabled(db, "proj-a", (skillA as Row).id as string, false, "u1");
  check("disabled skill excluded", (await getEnabledProjectSkills(db, "proj-a")).length === 0);

  // Ordering by name: enable both, check order.
  const skills = await listSkills(db, "ws-a");
  for (const s of skills) {
    await setProjectSkillEnabled(db, "proj-a", (s as Row).id as string, true, "u1");
  }
  const names = (await getEnabledProjectSkills(db, "proj-a")).map((s) => s.name);
  check("enabled skills ordered by name", JSON.stringify(names) === JSON.stringify(["Content Brief", "SEO Audit"]));

  // getSkill scoping.
  check("getSkill finds in workspace", (await getSkill(db, "ws-a", (skillA as Row).id as string)) !== null);
  check("getSkill null in other workspace", (await getSkill(db, "ws-b", (skillA as Row).id as string)) === null);

  // Uninstall removes skill + project bindings.
  const deleted = await uninstallSkill(db, "ws-a", (skillA as Row).id as string, "u1");
  check("uninstall returns deleted row", (deleted as Row).id === (skillA as Row).id);
  check("uninstalled skill gone", (await getSkill(db, "ws-a", (skillA as Row).id as string)) === null);
  check("project bindings removed", (await getEnabledProjectSkills(db, "proj-a")).length === 1);

  let missingThrew = false;
  try {
    await uninstallSkill(db, "ws-a", "sk-missing", "u1");
  } catch (e) {
    missingThrew = e instanceof SkillServiceError && /not found/.test((e as Error).message);
  }
  check("uninstall missing skill throws", missingThrew);
}

// ------------------------------------------------------------------ summary
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
