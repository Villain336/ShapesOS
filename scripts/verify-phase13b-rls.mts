#!/usr/bin/env tsx
// Marketr — Phase 13B RLS battery (docs/phases/13b/DATA-MODEL.md).
//
// Extends the Phase 8 battery (scripts/verify-phase8-memory.mts) to the
// six new Phase 13B tables + the three memory-mapped conventions:
//
//   agent_feedback, brand_voice_profiles, company_knowledge,
//   style_rules, content_records, persona_profiles
//   + memory_episodes(episodeType="agent_call")
//   + memory_learnings(source="consolidation")
//   + memory_facts(predicate="pref:*")
//
// Covers per table: FORCE RLS on, fail-closed (no GUC → zero rows),
// cross-workspace read isolation, write-to-another-workspace blocked,
// unscoped UPDATE is a no-op. Plus the new uniqueness contracts and the
// preference/pause conventions.
//
// Usage: tsx scripts/verify-phase13b-rls.mts
// Exits 1 on any failure.

import "dotenv/config";
import { prisma } from "../lib/prisma";
import {
  withWorkspaceScope,
  countWithoutScope,
} from "../lib/substrate/memory/rls";
import {
  setLearningPaused,
  getLearningPaused,
  setPreference,
  getPreferenceScoped,
  PREF_KEYS,
} from "../lib/substrate/memory/preferences";
import {
  captureEpisode,
  recordFeedback,
  captureEditDiff,
} from "../lib/agents/learning/capture";

// ---------------------------------------------------------------------------
// harness (mirrors scripts/verify-phase8-memory.mts)
// ---------------------------------------------------------------------------

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function section(title: string) {
  console.log(`\n## ${title}`);
}

const WS_A = "13b-battery-a";
const WS_B = "13b-battery-b";

const NEW_TABLES = [
  "agent_feedback",
  "brand_voice_profiles",
  "company_knowledge",
  "style_rules",
  "content_records",
  "persona_profiles",
] as const;

async function resetBatteryState() {
  for (const id of [WS_A, WS_B]) {
    await prisma.workspace.deleteMany({ where: { id } });
    await prisma.workspace.create({
      data: { id, name: `13b battery ${id}`, ownerUserId: "13b-battery-owner" },
    });
  }
}

async function seedWorkspaceA() {
  await withWorkspaceScope(WS_A, async (tx) => {
    const ep = await tx.memoryEpisode.create({
      data: {
        workspaceId: WS_A,
        episodeType: "agent_call",
        actor: "strategist",
        summary: "battery: agent call episode",
        refs: { promptSummary: "p", outputSummary: "o", outcome: "ok" },
        startedAt: new Date(),
      },
      select: { id: true },
    });
    await tx.agentFeedback.create({
      data: {
        workspaceId: WS_A,
        episodeId: ep.id,
        agentId: "strategist",
        kind: "explicit_up",
        signal: { source: "battery" },
      },
    });
    await tx.brandVoiceProfile.create({
      data: {
        workspaceId: WS_A,
        dimensions: { formality: "casual" },
        derivedFrom: { samples: [] },
        confidence: 0.5,
      },
    });
    await tx.companyKnowledge.create({
      data: {
        workspaceId: WS_A,
        kind: "product",
        title: "battery product",
        body: { summary: "x" },
        sourceEpisodeId: ep.id,
      },
    });
    await tx.styleRule.create({
      data: {
        workspaceId: WS_A,
        kind: "ban",
        pattern: "battery-phrase",
        severity: "block",
        source: "battery",
      },
    });
    await tx.contentRecord.create({
      data: {
        workspaceId: WS_A,
        kind: "blog_post",
        title: "battery post",
        angle: "battery angle",
        channel: "blog",
      },
    });
    await tx.personaProfile.create({
      data: {
        workspaceId: WS_A,
        agentId: "strategist",
        voice: { register: "direct" },
        continuityNotes: "battery",
        uncertaintyStyle: "battery",
      },
    });
    await tx.memoryLearning.create({
      data: {
        workspaceId: WS_A,
        hypothesis: "battery consolidation lesson",
        action: "battery consolidation pass",
        result: "inconclusive",
        metricDelta: { confidence: 0.7 },
        observedAt: new Date(),
        source: "consolidation",
        sourceEpisodeId: ep.id,
      },
    });
  });
  await setLearningPaused(WS_A, true);
  await setPreference(WS_A, PREF_KEYS.voiceStyle, "bold", {
    origin: "user_told",
    pinned: true,
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  await resetBatteryState();
  await seedWorkspaceA();

  section("1. FORCE RLS on all new Phase 13B tables");
  const rls = (await prisma.$queryRawUnsafe(
    `SELECT c.relname AS tablename, c.relrowsecurity AS rowsecurity,
            c.relforcerowsecurity AS force_rowsecurity
       FROM pg_class c
      WHERE c.relname = ANY($1)`,
    NEW_TABLES as unknown as string[],
  )) as Array<{ tablename: string; rowsecurity: boolean; force_rowsecurity: boolean }>;
  check(
    "FORCE RLS on all six new tables",
    rls.length === 6 && rls.every((r) => r.rowsecurity && r.force_rowsecurity),
    rls.map((r) => `${r.tablename}:${r.force_rowsecurity ? "forced" : "off"}`).join(" "),
  );

  section("2. Fail-closed: no GUC → zero rows on every new table");
  for (const t of NEW_TABLES) {
    const n = await countWithoutScope(t);
    check(`no-GUC read on ${t} returns zero`, n === 0, `${n} rows`);
  }

  section("3. Cross-workspace read isolation");
  await withWorkspaceScope(WS_B, async (tx) => {
    const counts = {
      feedback: await tx.agentFeedback.count(),
      voice: await tx.brandVoiceProfile.count(),
      knowledge: await tx.companyKnowledge.count(),
      rules: await tx.styleRule.count(),
      content: await tx.contentRecord.count(),
      personas: await tx.personaProfile.count(),
      agentCallEpisodes: await tx.memoryEpisode.count({
        where: { episodeType: "agent_call" },
      }),
      consolidationLearnings: await tx.memoryLearning.count({
        where: { source: "consolidation" },
      }),
      prefs: await tx.memoryFact.count({
        where: { predicate: { startsWith: "pref:" }, invalidAt: null },
      }),
    };
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    check("workspace B sees ZERO rows from workspace A", total === 0, JSON.stringify(counts));
  });
  await withWorkspaceScope(WS_A, async (tx) => {
    const n = await tx.agentFeedback.count();
    check("workspace A sees its own rows", n === 1, `${n} feedback rows`);
    const paused = await getLearningPaused(tx, WS_A);
    check("pause toggle reads true in workspace A", paused === true);
  });

  section("4. Write to another workspace is blocked (WITH CHECK)");
  const crossWriteAttempts: Array<[string, () => Promise<unknown>]> = [
    [
      "agent_feedback",
      () =>
        withWorkspaceScope(WS_A, (tx) =>
          tx.agentFeedback.create({
            data: { workspaceId: WS_B, agentId: "x", kind: "accepted", signal: {} },
          }),
        ),
    ],
    [
      "brand_voice_profiles",
      () =>
        withWorkspaceScope(WS_A, (tx) =>
          tx.brandVoiceProfile.create({
            data: { workspaceId: WS_B, dimensions: {}, derivedFrom: {} },
          }),
        ),
    ],
    [
      "company_knowledge",
      () =>
        withWorkspaceScope(WS_A, (tx) =>
          tx.companyKnowledge.create({
            data: { workspaceId: WS_B, kind: "other", title: "x", body: {} },
          }),
        ),
    ],
    [
      "style_rules",
      () =>
        withWorkspaceScope(WS_A, (tx) =>
          tx.styleRule.create({
            data: { workspaceId: WS_B, kind: "tone", pattern: "x", severity: "flag", source: "x" },
          }),
        ),
    ],
    [
      "content_records",
      () =>
        withWorkspaceScope(WS_A, (tx) =>
          tx.contentRecord.create({ data: { workspaceId: WS_B, kind: "x", title: "x" } }),
        ),
    ],
    [
      "persona_profiles",
      () =>
        withWorkspaceScope(WS_A, (tx) =>
          tx.personaProfile.create({
            data: {
              workspaceId: WS_B,
              agentId: "intruder",
              voice: {},
              continuityNotes: "x",
              uncertaintyStyle: "x",
            },
          }),
        ),
    ],
  ];
  for (const [label, attempt] of crossWriteAttempts) {
    let blocked = false;
    let detail = "";
    try {
      await attempt();
    } catch (e) {
      blocked = /row-level security/i.test((e as Error).message);
      detail = (e as Error).message.slice(0, 90);
    }
    check(`cross-workspace INSERT into ${label} blocked`, blocked, detail);
  }

  section("5. Unscoped UPDATE is a no-op (fail-closed on writes too)");
  const updated = (await prisma.$executeRawUnsafe(
    `UPDATE "style_rules" SET "pattern" = 'tampered' WHERE "pattern" = 'battery-phrase'`,
  )) as unknown as number;
  check("unscoped UPDATE touches zero rows", updated === 0, `${updated} rows`);
  await withWorkspaceScope(WS_A, async (tx) => {
    const row = await tx.styleRule.findFirst({ where: { pattern: "battery-phrase" } });
    check("row still intact after unscoped UPDATE attempt", row !== null);
  });

  section("6. Phase 13B mapping conventions on the memory stores");
  await withWorkspaceScope(WS_A, async (tx) => {
    const ep = await tx.memoryEpisode.findFirst({
      where: { episodeType: "agent_call" },
      select: { actor: true, refs: true },
    });
    check(
      "AgentEpisode ≡ memory_episodes(episodeType=agent_call)",
      ep?.actor === "strategist" &&
        (ep.refs as Record<string, unknown>).outcome === "ok",
    );
    const lesson = await tx.memoryLearning.findFirst({
      where: { source: "consolidation" },
      select: { metricDelta: true },
    });
    check(
      "AgentLesson ≡ memory_learnings(source=consolidation), confidence in metricDelta",
      (lesson?.metricDelta as Record<string, unknown>)?.confidence === 0.7,
    );
  });
  const voicePref = await getPreferenceScoped(WS_A, PREF_KEYS.voiceStyle);
  check(
    "WorkspacePreference ≡ memory_facts(predicate=pref:voice_style), pinned survives",
    voicePref?.value === "bold" && voicePref?.pinned === true && voicePref?.origin === "user_told",
  );

  section("7. Uniqueness contracts");
  let dupVoiceBlocked = false;
  try {
    await withWorkspaceScope(WS_A, (tx) =>
      tx.brandVoiceProfile.create({
        data: { workspaceId: WS_A, dimensions: {}, derivedFrom: {} },
      }),
    );
  } catch {
    dupVoiceBlocked = true;
  }
  check("brand_voice_profiles: one row per workspace", dupVoiceBlocked);
  let dupPersonaBlocked = false;
  try {
    await withWorkspaceScope(WS_A, (tx) =>
      tx.personaProfile.create({
        data: {
          workspaceId: WS_A,
          agentId: "strategist",
          voice: {},
          continuityNotes: "x",
          uncertaintyStyle: "x",
        },
      }),
    );
  } catch {
    dupPersonaBlocked = true;
  }
  check("persona_profiles: (workspaceId, agentId) unique", dupPersonaBlocked);
  await withWorkspaceScope(WS_B, async (tx) => {
    const row = await tx.personaProfile.create({
      data: {
        workspaceId: WS_B,
        agentId: "strategist",
        voice: {},
        continuityNotes: "x",
        uncertaintyStyle: "x",
      },
    });
    check("same agentId allowed in a DIFFERENT workspace", row.id.length > 0);
  });

  section("8. Worker-2 capture helpers: pause respect + tenant isolation");
  // WS_A has learning paused (seeded): all capture must be suppressed.
  const pausedEp = await captureEpisode({
    workspaceId: WS_A,
    agentId: "chief-strategy",
    promptSummary: "battery paused episode probe text",
  });
  check("captureEpisode suppressed when learning paused", pausedEp === null);
  const pausedFb = await recordFeedback({
    workspaceId: WS_A,
    agentId: "chief-strategy",
    kind: "explicit_up",
  });
  check("recordFeedback suppressed when learning paused", pausedFb === null);

  // WS_B is active: episode round-trip through the helper.
  const epId = await captureEpisode({
    workspaceId: WS_B,
    agentId: "content-brief",
    promptSummary: "battery draft probe",
    outputSummary: "battery draft body",
    outcome: "draft_generated",
    refs: { contentItemId: "battery-content-1", draftFull: "battery draft body" },
  });
  check(
    "captureEpisode writes agent_call episode",
    typeof epId === "string" && epId.length > 0,
    epId ?? "null (embedder down?)",
  );

  const fbId = await recordFeedback({
    workspaceId: WS_B,
    episodeId: epId,
    agentId: "content-brief",
    kind: "explicit_up",
    signal: { source: "ui" },
  });
  check("recordFeedback writes explicit_up row", typeof fbId === "string");

  const diffId = await captureEditDiff({
    workspaceId: WS_B,
    episodeId: epId,
    agentId: "content-brief",
    draft: "battery draft body",
    final: "battery draft body, edited by the user for tone",
  });
  check("captureEditDiff writes edit_diff row", typeof diffId === "string");
  if (diffId) {
    await withWorkspaceScope(WS_B, async (tx) => {
      const row = await tx.agentFeedback.findUnique({
        where: { id: diffId },
        select: { kind: true, signal: true, episodeId: true },
      });
      const sig = (row?.signal ?? {}) as Record<string, unknown>;
      const stats = (sig.diffStats ?? {}) as Record<string, unknown>;
      check(
        "edit_diff signal carries diffStats + changedRegions, linked to episode",
        row?.kind === "edit_diff" &&
          typeof stats.wordsAdded === "number" &&
          Array.isArray(stats.changedRegions) &&
          row?.episodeId === epId,
      );
    });
  }

  // Cross-workspace isolation through the helpers.
  await withWorkspaceScope(WS_A, async (tx) => {
    const n = await tx.agentFeedback.count({ where: { agentId: "content-brief" } });
    check("workspace A sees ZERO helper-written feedback rows", n === 0, `${n} rows`);
  });
  // A workspaceId smuggled inside the signal payload cannot redirect the write.
  const evilId = await recordFeedback({
    workspaceId: WS_B,
    agentId: "content-brief",
    kind: "accepted",
    signal: { workspaceId: WS_A, withEdits: false } as Record<string, unknown>,
  });
  let landedInA = -1;
  if (evilId) {
    await withWorkspaceScope(WS_A, async (tx) => {
      landedInA = await tx.agentFeedback.count({ where: { id: evilId } });
    });
  }
  check("payload-smuggled workspaceId cannot redirect the write", landedInA === 0, `${landedInA} rows in A`);

  section("cleanup");
  for (const id of [WS_A, WS_B]) {
    await prisma.workspace.deleteMany({ where: { id } });
  }
  check("battery workspaces removed (cascade)", true);

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) {
    console.log("FAILED:", failed.map((f) => f.name).join("; "));
    process.exit(1);
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("BATTERY CRASH:", e);
  await prisma.$disconnect();
  process.exit(1);
});
