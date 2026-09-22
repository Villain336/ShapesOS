// Marketr milestone 18 — fixture tests for the content autopilot engine.
// Pure functions + mock database: no live DB, no network, no LLM.
// Tests: rule validation, candidate dedupe/caps, auto-approve eligibility,
// kill-switch semantics, run orchestration (idempotency, kill enforcement),
// approval gates, and markdown→Tiptap conversion.
//
// Run: npx tsx scripts/verify-m18-autopilot.mts

import {
  AUTOPILOT_SOURCES,
  capCandidates,
  clampMaxItemsPerRun,
  dedupeCandidates,
  isAutoApproveEligible,
  isKilledForProject,
  markdownToSimpleBlocks,
  markdownToTiptap,
  scopeKeyFor,
  validatePublishTarget,
  validateRuleInput,
  MAX_ITEMS_PER_RUN_HARD_CAP,
  type AutopilotCandidate,
} from "@/lib/seo/autopilot";
import {
  approveAutopilotItem,
  isAutopilotKilled,
  killAutopilot,
  publishAutopilotItem,
  rejectAutopilotItem,
  runAutopilotRule,
  unkillAutopilot,
} from "@/lib/seo/autopilot-service";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: unknown, name: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(name);
    console.error(`FAIL: ${name}`);
  }
}

function throws(fn: () => unknown, name: string, match?: RegExp) {
  try {
    fn();
    ok(false, `${name} (expected throw)`);
  } catch (e) {
    ok(!match || match.test(e instanceof Error ? e.message : String(e)), name);
  }
}

async function throwsAsync(fn: () => Promise<unknown>, name: string, match?: RegExp) {
  try {
    await fn();
    ok(false, `${name} (expected throw)`);
  } catch (e) {
    ok(!match || match.test(e instanceof Error ? e.message : String(e)), name);
  }
}

// ---------------------------------------------------------------------------
// 1. Rule input validation
// ---------------------------------------------------------------------------

const good = validateRuleInput({ name: "Weekly refresh", source: "decay_refresh", cadence: "weekly" });
ok(good.name === "Weekly refresh", "validate: name preserved");
ok(good.source === "decay_refresh", "validate: source preserved");
ok(good.maxItemsPerRun === 5, "validate: default max items = 5");
ok(good.autoApprove === false, "validate: autoApprove defaults OFF");
ok(good.enabled === true, "validate: enabled defaults true");
ok(good.publishTarget === null, "validate: publishTarget defaults null");

throws(() => validateRuleInput({ source: "decay_refresh" }), "validate: missing name throws", /name/i);
throws(() => validateRuleInput({ name: "x", source: "bogus" }), "validate: bad source throws", /source/i);
throws(
  () => validateRuleInput({ name: "x", source: "programmatic_template" }),
  "validate: programmatic_template without templateId throws",
  /template/i,
);
const withTemplate = validateRuleInput({ name: "x", source: "programmatic_template", programmaticTemplateId: "t1" });
ok(withTemplate.programmaticTemplateId === "t1", "validate: templateId kept for programmatic source");

ok(clampMaxItemsPerRun(0) === 1, "clamp: 0 → 1");
ok(clampMaxItemsPerRun(-5) === 1, "clamp: negative → 1");
ok(clampMaxItemsPerRun(10_000) === MAX_ITEMS_PER_RUN_HARD_CAP, "clamp: huge → hard cap");
ok(clampMaxItemsPerRun(NaN) === 5, "clamp: NaN → default");
ok(clampMaxItemsPerRun("x") === 5, "clamp: non-number → default");

const pt = validatePublishTarget({ kind: "marketr-site", siteId: "s1" });
ok(pt?.kind === "marketr-site" && pt?.siteId === "s1", "validate: publish target parsed");
ok(validatePublishTarget(null) === null, "validate: null publish target → null");
throws(() => validatePublishTarget({ kind: "carrier-pigeon" }), "validate: bad target kind throws", /kind/i);

// ---------------------------------------------------------------------------
// 2. Candidate dedupe + caps (idempotency)
// ---------------------------------------------------------------------------

const cands: AutopilotCandidate[] = [
  { kind: "decay_refresh", sourceRef: "a", title: "A", priority: 2, brief: "b" },
  { kind: "decay_refresh", sourceRef: "b", title: "B", priority: 0, brief: "b" },
  { kind: "decay_refresh", sourceRef: "c", title: "C", priority: 1, brief: "b" },
];

const deduped = dedupeCandidates(cands, [
  { kind: "decay_refresh", sourceRef: "a", status: "pending" },
  { kind: "decay_refresh", sourceRef: "b", status: "approved" },
  { kind: "decay_refresh", sourceRef: "c", status: "rejected" }, // resolved → not blocked
]);
ok(deduped.length === 1 && deduped[0].sourceRef === "c", "dedupe: pending/approved block, rejected does not");

const capped = capCandidates(cands, 2);
ok(capped.length === 2 && capped[0].sourceRef === "b" && capped[1].sourceRef === "c", "cap: priority order + limit");

const cappedHard = capCandidates(
  Array.from({ length: 60 }, (_, i) => ({ kind: "decay_refresh" as const, sourceRef: `s${i}`, title: "t", priority: i, brief: "b" })),
  60,
);
ok(cappedHard.length === MAX_ITEMS_PER_RUN_HARD_CAP, "cap: hard cap enforced even when asked for more");

// ---------------------------------------------------------------------------
// 3. Auto-approve eligibility
// ---------------------------------------------------------------------------

ok(isAutoApproveEligible("decay_refresh", true) === true, "auto-approve: decay + opt-in → eligible");
ok(isAutoApproveEligible("decay_refresh", false) === false, "auto-approve: decay without opt-in → not eligible");
ok(isAutoApproveEligible("programmatic_page", true) === false, "auto-approve: programmatic never auto-approved");
ok(isAutoApproveEligible("keyword_brief", true) === false, "auto-approve: keyword never auto-approved");

// ---------------------------------------------------------------------------
// 4. Kill-switch scope semantics
// ---------------------------------------------------------------------------

ok(scopeKeyFor({ projectId: "p1" }) === "project:p1", "scope: project key");
ok(scopeKeyFor({ workspaceId: "w1" }) === "workspace:w1", "scope: workspace key");
throws(() => scopeKeyFor({ projectId: "p1", workspaceId: "w1" }), "scope: both ids throws");
throws(() => scopeKeyFor({}), "scope: no ids throws");

const rows = [
  { scopeKey: "workspace:w1", killed: true },
  { scopeKey: "project:p2", killed: true },
];
ok(isKilledForProject(rows, "w1", "p9") === true, "killed: workspace kill covers its projects");
ok(isKilledForProject(rows, "w2", "p2") === true, "killed: project kill covers the project");
ok(isKilledForProject(rows, "w2", "p9") === false, "killed: unrelated scope not killed");
ok(isKilledForProject([], "w1", "p1") === false, "killed: no rows → not killed");
ok(isKilledForProject([{ scopeKey: "workspace:w1", killed: false }], "w1", "p1") === false, "killed: unkilled row → not killed");

// ---------------------------------------------------------------------------
// 5. Markdown → Tiptap conversion
// ---------------------------------------------------------------------------

const blocks = markdownToSimpleBlocks("# Title\n\nSome text.\n\n- one\n- two\n\n## Sub\n\nMore.");
ok(blocks.some((b) => b.type === "h1" && b.text === "Title"), "md: h1 parsed");
ok(blocks.some((b) => b.type === "h2" && b.text === "Sub"), "md: h2 parsed");
ok(blocks.filter((b) => b.type === "bullet").length === 2, "md: bullets parsed");
ok(blocks.some((b) => b.type === "paragraph" && b.text === "Some text."), "md: paragraph parsed");

const doc = markdownToTiptap("# Hello") as { type: string; content: unknown[] };
ok(doc.type === "doc" && Array.isArray(doc.content) && doc.content.length > 0, "md: tiptap doc produced");
ok(markdownToSimpleBlocks("").length === 0, "md: empty → no blocks");

// ---------------------------------------------------------------------------
// 6. Service orchestration with a mock db
// ---------------------------------------------------------------------------

interface Call { model: string; method: string; args?: unknown }
const calls: Call[] = [];

function mockDb(overrides: Record<string, Record<string, (...a: never[]) => unknown>> = {}) {
  const defaults: Record<string, Record<string, (...a: never[]) => unknown>> = {
    autopilotRule: {
      findFirst: async () => ({
        id: "rule1", projectId: "proj1", source: "decay_refresh", programmaticTemplateId: null,
        maxItemsPerRun: 2, autoApprove: false, enabled: true, publishTarget: null, name: "R",
      }),
      update: async () => ({}),
    },
    autopilotKillSwitch: { findMany: async () => [] },
    autopilotRun: {
      create: async () => ({ id: "run1" }),
      update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
    },
    contentDecayFinding: {
      findMany: async () => [
        { id: "f1", url: "/a", phrases: ["kw a"], decayScore: 80 },
        { id: "f2", url: "/b", phrases: ["kw b"], decayScore: 70 },
        { id: "f3", url: "/c", phrases: ["kw c"], decayScore: 60 },
      ],
    },
    autopilotItem: {
      findMany: async () => [],
      findFirst: async () => null,
      create: async (a: { data: Record<string, unknown> }) => ({ id: `item-${a.data.sourceRef}`, title: a.data.title, status: a.data.status, autoApproved: a.data.autoApproved, kind: a.data.kind, runId: "run1", rule: { publishTarget: null } }),
      update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
    },
    fileChangeLog: { create: async () => ({}) },
  };
  const merged: Record<string, Record<string, (...a: never[]) => unknown>> = {};
  for (const k of Object.keys(defaults)) merged[k] = { ...defaults[k], ...(overrides[k] ?? {}) };
  for (const k of Object.keys(overrides)) if (!merged[k]) merged[k] = overrides[k];
  const db = new Proxy(merged, {
    get(t, prop) {
      const model = String(prop);
      return new Proxy({}, {
        get(_, method) {
          return async (...a: never[]) => {
            calls.push({ model, method: String(method), args: a[0] });
            const fn = (merged[model] ?? {})[String(method)];
            if (fn) return fn(...a);
            throw new Error(`unmocked ${model}.${String(method)}`);
          };
        },
      });
    },
  });
  return db as never;
}

const stubGenerator = async (c: AutopilotCandidate) => ({ title: c.title, markdown: `# ${c.title}\n\nBody.` });

{
  const db = mockDb();
  const res = await runAutopilotRule(db as never, {
    workspaceId: "w1", projectId: "proj1", ruleId: "rule1", actor: "u1", draftGenerator: stubGenerator,
  });
  ok(res.generated === 2, "run: per-run cap enforced (2 of 3 candidates)");
  ok(res.autoApproved === 0, "run: no auto-approve when rule opts out");
  ok(res.skippedInFlight === 1, "run: cap applied counts as skipped");
  const runCreates = calls.filter((c) => c.model === "autopilotRun" && c.method === "create");
  ok(runCreates.length === 1, "run: exactly one run row created");
  const auditActions = calls.filter((c) => c.model === "fileChangeLog").map((c) => (c.args as { data: { action: string } }).data.action);
  ok(auditActions.includes("autopilot_run_started"), "run: run-started audit logged");
  ok(auditActions.includes("autopilot_run_finished"), "run: run-finished audit logged");
  ok(auditActions.filter((a) => a === "autopilot_item_generated").length === 2, "run: each item generation audit-logged");
}

{
  // Auto-approve ON for decay_refresh: items approved + explicitly audit-logged.
  const db = mockDb({
    autopilotRule: { findFirst: async () => ({ id: "rule1", projectId: "proj1", source: "decay_refresh", programmaticTemplateId: null, maxItemsPerRun: 5, autoApprove: true, enabled: true, publishTarget: null, name: "R" }) },
  });
  calls.length = 0;
  const res = await runAutopilotRule(db as never, { workspaceId: "w1", projectId: "proj1", ruleId: "rule1", actor: "u1", draftGenerator: stubGenerator });
  ok(res.autoApproved === 3, "run: auto-approve applied to decay items when opted in");
  const itemCreates = calls.filter((c) => c.model === "autopilotItem" && c.method === "create");
  ok(itemCreates.every((c) => (c.args as { data: { status: string } }).data.status === "approved"), "run: auto-approved items created with approved status");
  ok(itemCreates.every((c) => (c.args as { data: { autoApproved: boolean } }).data.autoApproved === true), "run: autoApproved flag set");
  const auditActions = calls.filter((c) => c.model === "fileChangeLog").map((c) => (c.args as { data: { action: string } }).data.action);
  ok(auditActions.includes("autopilot_item_approved"), "run: auto-approval explicitly audit-logged");
}

{
  // Kill switch blocks a run before it starts.
  const db = mockDb({ autopilotKillSwitch: { findMany: async () => [{ scopeKey: "project:proj1", killed: true }] } });
  calls.length = 0;
  await throwsAsync(
    () => runAutopilotRule(db as never, { workspaceId: "w1", projectId: "proj1", ruleId: "rule1", actor: "u1", draftGenerator: stubGenerator }),
    "run: killed project refuses to start a run",
    /killed/i,
  );
  ok(!calls.some((c) => c.model === "autopilotRun" && c.method === "create"), "run: no run row created when killed");
  ok(await isAutopilotKilled(db as never, "w1", "proj1") === true, "kill: isAutopilotKilled true for killed project");
  ok(await isAutopilotKilled(mockDb() as never, "w1", "proj1") === false, "kill: isAutopilotKilled false when no rows");
}

{
  // Idempotency: in-flight items are skipped across runs.
  const db = mockDb({
    autopilotItem: { findMany: async () => [{ kind: "decay_refresh", sourceRef: "f1", status: "pending" }] },
  });
  calls.length = 0;
  const res = await runAutopilotRule(db as never, { workspaceId: "w1", projectId: "proj1", ruleId: "rule1", actor: "u1", draftGenerator: stubGenerator });
  ok(res.generated === 2, "run: in-flight candidate skipped, only new ones generated");
  const createdRefs = calls.filter((c) => c.model === "autopilotItem" && c.method === "create").map((c) => (c.args as { data: { sourceRef: string } }).data.sourceRef);
  ok(!createdRefs.includes("f1"), "run: in-flight sourceRef never regenerated");
}

{
  // Approval gates.
  const pendingItem = { id: "item-f1", status: "pending", title: "T", kind: "decay_refresh", runId: "run1", rule: { publishTarget: null } };
  const db = mockDb({ autopilotItem: { findFirst: async () => pendingItem } });
  calls.length = 0;
  await approveAutopilotItem(db as never, { workspaceId: "w1", projectId: "proj1", itemId: "item-f1", actor: "u1" });
  const upd = calls.find((c) => c.model === "autopilotItem" && c.method === "update");
  ok((upd?.args as { data: { status: string } } | undefined)?.data.status === "approved", "gate: pending → approved");
  const auditActions = calls.filter((c) => c.model === "fileChangeLog").map((c) => (c.args as { data: { action: string } }).data.action);
  ok(auditActions.includes("autopilot_item_approved"), "gate: approval audit-logged");

  calls.length = 0;
  await rejectAutopilotItem(db as never, { workspaceId: "w1", projectId: "proj1", itemId: "item-f1", actor: "u1", note: "off-brand" });
  const rejUpd = calls.find((c) => c.model === "autopilotItem" && c.method === "update");
  ok((rejUpd?.args as { data: { status: string } } | undefined)?.data.status === "rejected", "gate: pending → rejected");

  // Publish requires approved status.
  const approvedItem = { ...pendingItem, status: "approved", draftMarkdown: "# T\n\nBody.", sourceRef: "f1" };
  const dbApproved = mockDb({ autopilotItem: { findFirst: async () => approvedItem }, site: { findFirst: async () => null } });
  await throwsAsync(
    () => publishAutopilotItem(dbApproved as never, { workspaceId: "w1", projectId: "proj1", itemId: "item-f1", actor: "u1", userId: "u1" }),
    "gate: decay publish without a site fails loudly (no silent no-op)",
    /no site/i,
  );
  await throwsAsync(
    () => publishAutopilotItem(db as never, { workspaceId: "w1", projectId: "proj1", itemId: "item-f1", actor: "u1", userId: "u1" }),
    "gate: publish blocked for non-approved items",
    /approved/i,
  );

  // Kill blocks approval.
  const dbKilled = mockDb({
    autopilotItem: { findFirst: async () => pendingItem },
    autopilotKillSwitch: { findMany: async () => [{ scopeKey: "workspace:w1", killed: true }] },
  });
  await throwsAsync(
    () => approveAutopilotItem(dbKilled as never, { workspaceId: "w1", projectId: "proj1", itemId: "item-f1", actor: "u1" }),
    "gate: approval blocked while killed",
    /killed/i,
  );
}

{
  // Kill switch: freezes runs + items, audit-logged. Un-kill is explicit.
  const db = mockDb({
    autopilotKillSwitch: {
      findMany: async () => [],
      upsert: async () => ({ scopeKey: "project:proj1", killed: true }),
    },
  });
  calls.length = 0;
  await killAutopilot(db as never, { workspaceId: "w1", projectId: "proj1", actor: "u1", reason: "bad drafts" });
  const ks = calls.find((c) => c.model === "autopilotKillSwitch" && c.method === "upsert");
  ok((ks?.args as { create: { killed: boolean } } | undefined)?.create.killed === true, "kill: kill row upserted with killed=true");
  ok(calls.some((c) => c.model === "autopilotRun" && c.method === "updateMany"), "kill: running runs frozen");
  ok(calls.some((c) => c.model === "autopilotItem" && c.method === "updateMany"), "kill: in-flight items frozen");
  const auditActions = calls.filter((c) => c.model === "fileChangeLog").map((c) => (c.args as { data: { action: string } }).data.action);
  ok(auditActions.includes("autopilot_killed"), "kill: kill audit-logged");

  calls.length = 0;
  await unkillAutopilot(db as never, { workspaceId: "w1", projectId: "proj1", actor: "u1" });
  const unks = calls.find((c) => c.model === "autopilotKillSwitch" && c.method === "upsert");
  ok((unks?.args as { update: { killed: boolean } } | undefined)?.update.killed === false, "kill: un-kill requires an explicit action");
  ok(!calls.some((c) => c.model === "autopilotRun"), "kill: un-kill does NOT silently resume runs");
  const unAudit = calls.filter((c) => c.model === "fileChangeLog").map((c) => (c.args as { data: { action: string } }).data.action);
  ok(unAudit.includes("autopilot_unkilled"), "kill: un-kill audit-logged");
}

// ---------------------------------------------------------------------------
console.log(`\nverify-m18-autopilot: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`- ${f}\n`);
  process.exit(1);
}
