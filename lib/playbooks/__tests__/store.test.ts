// Marketr — Phase 9 M5: playbook store tests.
// Run: npx tsx --test lib/playbooks/__tests__/store.test.ts
//
// DB-backed (preview Postgres, port 5433): each run uses a fresh workspace id
// and deletes it at teardown (cascade removes playbooks + versions).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../../lib/prisma";
import { withWorkspaceScope } from "../../../lib/substrate/graph/rls";
import {
  assertTransition,
  contentHashOf,
  createPlaybook,
  createVersion,
  deleteVersion,
  exportPlaybook,
  getPlaybook,
  getSharingOptIn,
  importPlaybook,
  listPlaybooks,
  proposeFromLearning,
  recordEval,
  resolveLabel,
  runPlaybook,
  setLabel,
  setSharingOptIn,
  transitionVersion,
  updateVersion,
  type PlaybookContent,
} from "../store";

const WS = `ws_playbook_test_${randomUUID().slice(0, 8)}`;
const USER = "user_test_owner";

function content(title: string): PlaybookContent {
  return {
    title,
    summary: "summary",
    steps: [
      { title: "Step one", detail: "do the thing", executor: "researcher" },
      { title: "Step two", detail: "do the next thing", executor: "planner" },
    ],
    guardrails: ["never auto-send"],
  };
}

before(async () => {
  await prisma.workspace.create({
    data: { id: WS, name: "Playbook M5 test", ownerUserId: USER },
  });
});

after(async () => {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

describe("lifecycle guard", () => {
  it("allows each ordered step", () => {
    assertTransition("draft", "eval");
    assertTransition("eval", "review");
    assertTransition("review", "canary");
    assertTransition("canary", "production");
    assertTransition("production", "deprecated");
  });

  it("rejects skips (draft→production, eval→production, review→production)", () => {
    assert.throws(() => assertTransition("draft", "production"), /not allowed/);
    assert.throws(() => assertTransition("eval", "production"), /not allowed/);
    assert.throws(() => assertTransition("review", "production"), /not allowed/);
  });

  it("rejects backward moves and unknown statuses", () => {
    assert.throws(() => assertTransition("review", "eval"), /not allowed/);
    assert.throws(() => assertTransition("production", "canary"), /not allowed/);
    assert.throws(() => assertTransition("draft", "shipped" as never), /unknown/);
  });
});

describe("immutability", () => {
  it("exposes no content update/delete path (sentinels throw)", () => {
    assert.throws(() => updateVersion(), /immutable/);
    assert.throws(() => deleteVersion(), /immutable/);
  });

  it("new versions get version = max+1 with a stable content hash", async () => {
    const { id } = await createPlaybook(WS, { name: "Immutable playbook", source: "seed" }, USER);
    const v1 = await createVersion(WS, id, content("v1"), USER);
    const v2 = await createVersion(WS, id, content("v1"), USER);
    assert.equal(v1.version, 1);
    assert.equal(v2.version, 2);
    assert.equal(v1.contentHash, v2.contentHash);
    assert.equal(v1.contentHash, contentHashOf(content("v1")));
  });
});

describe("label pointers", () => {
  it("pointer moves do not rewrite history", async () => {
    const { id } = await createPlaybook(WS, { name: "Pointer playbook", source: "seed" }, USER);
    const v1 = await createVersion(WS, id, content("old procedure"), USER);
    const v2 = await createVersion(WS, id, content("new procedure"), USER);

    await setLabel(WS, id, "production", v1.version);
    const before = await getPlaybook(WS, id);
    const v1Before = before!.versions.find((v) => v.version === 1)!;
    const hashBefore = v1Before.contentHash;

    // Move the pointer to v2: v1 must lose the label but keep its row intact.
    await setLabel(WS, id, "production", v2.version);
    const after = await getPlaybook(WS, id);
    const v1After = after!.versions.find((v) => v.version === 1)!;
    const v2After = after!.versions.find((v) => v.version === 2)!;

    assert.ok(!v1After.labels.includes("production"));
    assert.ok(v2After.labels.includes("production"));
    assert.deepEqual(v1After.content, v1Before.content);
    assert.equal(v1After.contentHash, hashBefore);
  });

  it("rollback = pointer flip back to the previous version", async () => {
    const { id } = await createPlaybook(WS, { name: "Rollback playbook", source: "seed" }, USER);
    await createVersion(WS, id, content("a"), USER);
    await createVersion(WS, id, content("b"), USER);
    await setLabel(WS, id, "production", 2);
    assert.equal((await resolveLabel(WS, id, "production"))!.version, 2);
    await setLabel(WS, id, "production", 1); // rollback
    assert.equal((await resolveLabel(WS, id, "production"))!.version, 1);
  });
});

describe("lifecycle transitions", () => {
  it("rejects direct draft→production at the API boundary", async () => {
    const { id } = await createPlaybook(WS, { name: "Guard playbook", source: "seed" }, USER);
    const v = await createVersion(WS, id, content("x"), USER);
    await assert.rejects(
      transitionVersion(WS, v.id, "production", { approver: USER }),
      /not allowed/,
    );
  });

  it("walks the full lifecycle; production requires and records a human approver", async () => {
    const { id } = await createPlaybook(WS, { name: "Lifecycle playbook", source: "seed" }, USER);
    const v = await createVersion(WS, id, content("x"), USER);
    await transitionVersion(WS, v.id, "eval", { approver: USER });
    await transitionVersion(WS, v.id, "review", { approver: USER });
    await assert.rejects(transitionVersion(WS, v.id, "production", { approver: USER }), /not allowed/);
    await transitionVersion(WS, v.id, "canary", { approver: USER });
    await transitionVersion(WS, v.id, "production", { approver: USER });

    const got = await getPlaybook(WS, id);
    const row = got!.versions.find((r) => r.id === v.id)!;
    assert.equal(row.status, "production");
    const approval = (row.outcomeAttribution as Record<string, unknown>).productionApproval as {
      approvedBy: string;
    };
    assert.equal(approval.approvedBy, USER);
    // Production promotion moves the production pointer.
    assert.equal((await resolveLabel(WS, id, "production"))!.version, 1);
  });
});

describe("outcome evals", () => {
  it("records metric deltas with honest uncertainty bars", async () => {
    const { id } = await createPlaybook(WS, { name: "Eval playbook", source: "learned" }, USER);
    const v = await createVersion(WS, id, content("x"), USER);
    const { eval: stored } = await recordEval(
      WS,
      v.id,
      {
        metricDeltas: { bookedJobsLiftPct: 12 },
        attributionNote:
          "Lift observed vs control in 2 weeks; NOT proven: seasonality not ruled out, sample is small.",
        uncertainty: { lowerBound: 4, upperBound: 19, basis: "n=14 runs, bootstrap 95% CI" },
      },
      USER,
    );
    assert.equal(stored.metricDeltas.bookedJobsLiftPct, 12);
    assert.equal(stored.uncertainty.lowerBound, 4);
    assert.equal(stored.uncertainty.upperBound, 19);
    assert.ok(stored.attributionNote.includes("NOT proven"));

    const got = await getPlaybook(WS, id);
    const row = got!.versions.find((r) => r.id === v.id)!;
    assert.deepEqual(row.eval, stored);
  });

  it("requires the attribution note and a well-formed uncertainty", async () => {
    const { id } = await createPlaybook(WS, { name: "Eval guard playbook", source: "learned" }, USER);
    const v = await createVersion(WS, id, content("x"), USER);
    await assert.rejects(
      recordEval(WS, v.id, {
        metricDeltas: {},
        attributionNote: "too short",
        uncertainty: { lowerBound: 1, upperBound: 2, basis: "x" },
      }, USER),
      /attributionNote/,
    );
    await assert.rejects(
      recordEval(WS, v.id, {
        metricDeltas: {},
        attributionNote: "long enough note that says nothing specific",
        uncertainty: { lowerBound: 9, upperBound: 2, basis: "x" },
      }, USER),
      /lowerBound/,
    );
  });
});

describe("community sharing (OFF by default)", () => {
  it("export is gated: OFF by default, and requires the explicit opt-in", async () => {
    const { id } = await createPlaybook(WS, { name: "Gate playbook", source: "seed" }, USER);
    await createVersion(WS, id, content("x"), USER);
    assert.equal(await getSharingOptIn(WS), false);
    await assert.rejects(exportPlaybook(WS, id), /opt-in/);
    await setSharingOptIn(WS, true, USER);
    assert.equal(await getSharingOptIn(WS), true);
    const exp = await exportPlaybook(WS, id);
    assert.equal(exp.format, "marketr.playbook/v1");
    await setSharingOptIn(WS, false, USER);
    await assert.rejects(exportPlaybook(WS, id), /opt-in/);
  });

  it("anonymized export contains zero tenant identifiers", async () => {
    const { id } = await createPlaybook(
      WS,
      { name: "Tenanty playbook", source: "learned", description: "for Acme Dental" },
      USER,
    );
    await createVersion(
      WS,
      id,
      {
        title: "Review sprint",
        summary: "What worked for Acme Dental LLC",
        steps: [
          {
            title: "Follow up with the owner",
            detail:
              "Jane Smith at Acme Dental LLC confirmed that the Friday photo posts drove a $12,400 uplift quarter.",
            executor: "analyst",
          },
        ],
      } as PlaybookContent,
      USER,
    );
    await setSharingOptIn(WS, true, USER);
    const exp = await exportPlaybook(WS, id);
    const blob = JSON.stringify(exp);
    for (const needle of [WS, "Acme", "acmedental", "jane@", "Jane Smith", "12,400", "$12"]) {
      assert.ok(!blob.includes(needle), `export leaked tenant signal: ${needle}`);
    }
    assert.ok(exp.removedKinds.length > 0, "expected anonymizer to remove something");
    assert.ok(!("workspaceId" in exp), "export envelope must not carry a workspace id");
    await setSharingOptIn(WS, false, USER);
  });

  it("quarantines exports the anonymizer cannot confidently strip", async () => {
    const { id } = await createPlaybook(WS, { name: "Dense PII playbook", source: "learned" }, USER);
    await createVersion(
      WS,
      id,
      {
        title: "PII-dense",
        summary: "x",
        steps: [
          {
            title: "Contact",
            detail:
              "Jane Smith at jane@acmedental.com, 555-867-5309 — spent $12,400, 123 Main Street, Raleigh. See https://acmedental.com/dashboard for details.",
          },
        ],
      } as PlaybookContent,
      USER,
    );
    await setSharingOptIn(WS, true, USER);
    await assert.rejects(exportPlaybook(WS, id), /quarantined/);
    await setSharingOptIn(WS, false, USER);
  });

  it("import starts at draft v1 and must travel the lifecycle", async () => {
    const { id } = await createPlaybook(WS, { name: "Importable playbook", source: "seed" }, USER);
    await createVersion(WS, id, content("export me"), USER);
    await setSharingOptIn(WS, true, USER);
    const exp = await exportPlaybook(WS, id);

    const imported = await importPlaybook(
      WS,
      exp as unknown as Record<string, unknown>,
      USER,
    );
    const got = await getPlaybook(WS, imported.playbookId);
    assert.equal(got!.playbook.source, "community");
    assert.equal(got!.versions.length, 1);
    assert.equal(got!.versions[0].version, 1);
    assert.equal(got!.versions[0].status, "draft");
    // Imported content must travel EVAL before use — no skip path.
    await assert.rejects(
      transitionVersion(WS, got!.versions[0].id, "production", { approver: USER }),
      /not allowed/,
    );
    await transitionVersion(WS, got!.versions[0].id, "eval", { approver: USER });
    await setSharingOptIn(WS, false, USER);
  });
});

describe("learned promotion", () => {
  it("drafts a playbook from a memory_learning at status review — never auto-promotes", async () => {
    const learningId = randomUUID();
    await withWorkspaceScope(WS, async (tx) => {
      await tx.memoryLearning.create({
        data: {
          id: learningId,
          workspaceId: WS,
          hypothesis: "Posting GBP photos on Fridays lifts calls",
          action: "Scheduled Friday GBP photo posts for 4 weeks",
          result: "worked",
          metricDelta: { callsLiftPct: 9 },
          observedAt: new Date(),
          source: "human",
        },
      });
    });
    const { playbookId, version } = await proposeFromLearning(WS, learningId, USER);
    const got = await getPlaybook(WS, playbookId);
    assert.equal(got!.playbook.source, "learned");
    assert.equal(version, 1);
    assert.equal(got!.versions[0].status, "review");
    const provenance = (got!.versions[0].content as PlaybookContent).provenance as {
      learningId: string;
    };
    assert.equal(provenance.learningId, learningId);
    // From review it can only move to canary (then production) — still gated.
    await assert.rejects(
      transitionVersion(WS, got!.versions[0].id, "production", { approver: USER }),
      /not allowed/,
    );
  });
});

describe("runs", () => {
  it("resolves the production label and returns a propose-only drafted plan", async () => {
    const { id } = await createPlaybook(WS, { name: "Runnable playbook", source: "seed" }, USER);
    const v = await createVersion(WS, id, content("run me"), USER);
    await setLabel(WS, id, "production", v.version);

    const run = await runPlaybook(WS, USER, id, { goal: "more jobs" });
    assert.equal(run.version, 1);
    assert.equal(run.contentHash, v.contentHash);
    assert.equal(run.plan.length, 2);
    assert.equal(run.plan[0].order, 1);
    assert.equal(run.plan[0].mode, "proposed");
    assert.ok(run.runLogId.length > 0);
    assert.ok(run.note.includes("Nothing was executed"));

    // No production version → run fails loudly.
    const { id: id2 } = await createPlaybook(WS, { name: "Unpromoted playbook", source: "seed" }, USER);
    await createVersion(WS, id2, content("x"), USER);
    await assert.rejects(runPlaybook(WS, USER, id2, {}), /no production version/);
  });

  it("list shows production version + outcome lift summary", async () => {
    const { id } = await createPlaybook(WS, { name: "Listed playbook", source: "learned" }, USER);
    const v = await createVersion(WS, id, content("x"), USER);
    await recordEval(
      WS,
      v.id,
      {
        metricDeltas: { bookedJobsLiftPct: 12 },
        attributionNote: "Observed lift; NOT proven: seasonality not ruled out.",
        uncertainty: { lowerBound: 4, upperBound: 19, basis: "n=14, bootstrap 95% CI" },
      },
      USER,
    );
    await setLabel(WS, id, "production", 1);
    const items = await listPlaybooks(WS);
    const item = items.find((p) => p.id === id)!;
    assert.equal(item.productionVersion, 1);
    assert.equal(item.outcomeLift?.metric, "bookedJobsLiftPct");
    assert.equal(item.outcomeLift?.liftPct, 12);
  });
});
