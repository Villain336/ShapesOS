#!/usr/bin/env tsx
// Marketr — Phase 13D demo seed ("shots") for the preview server / screenshots.
//
// Creates (or reuses) the admin user's workspace and seeds the 13D demo rows.
// Worker sections are marked; the sibling owns [13D-A], Worker B owns [13D-B].
//
// [13D-B] Worker B (voiceovers):
//   - one voiceover agent (purpose=voiceover, VoiceStudio voice "alloy")
//   - 3 pronunciation entries
//   - one READY voiceover job with a REAL wav rendered by the live
//     VoiceStudio backend (http://localhost:3900 must be up)
//
// Run: DATABASE_URL=… npx tsx scripts/seed-phase13d-shots.mts
// Needs DATABASE_URL in env (uses the preview .env when run from repo root).

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}

const fs = await import("node:fs");
const envFile = fs.readFileSync(".env", "utf8");
const adminEmail = (envFile.match(/^ADMIN_EMAIL=(.*)$/m)?.[1] ?? "")
  .replace(/^"|"$/g, "")
  .trim()
  .toLowerCase();
if (!adminEmail) throw new Error("ADMIN_EMAIL missing in .env");
const userId = `admin:${adminEmail}`;

const { prisma } = await import("@/lib/prisma");
const { withWorkspaceScope } = await import("@/lib/substrate/memory/rls");

// Workspace the admin login resolves to (mirrors getOrCreateWorkspace).
let ws = await prisma.workspace.findFirst({ where: { ownerUserId: userId } });
if (!ws) {
  ws = await prisma.workspace.create({
    data: {
      name: "Launchabl demo",
      ownerUserId: userId,
      plan: "self_hosted",
      members: { create: { userId, role: "owner" } },
    },
  });
  console.log("created workspace", ws.id);
}
const workspaceId = ws.id;

// ---------------------------------------------------------------------------
// [13D-B] Worker B: voiceovers seed
// ---------------------------------------------------------------------------
{
  const { synthesizeWithKnownVoice, health } = await import("@/lib/voice/voicestudio");
  const { LocalDiskAdapter } = await import("@/lib/filesystem/storage");
  const { randomUUID } = await import("node:crypto");

  // 1. One voiceover agent (find-or-create; VoiceStudio is the default backend).
  let agent = await withWorkspaceScope(workspaceId, (tx) =>
    tx.voiceAgent.findFirst({ where: { workspaceId, purpose: "voiceover" } }),
  );
  if (!agent) {
    agent = await withWorkspaceScope(workspaceId, (tx) =>
      tx.voiceAgent.create({
        data: {
          workspaceId,
          name: "Marketr Narrator",
          purpose: "voiceover",
          voiceId: "alloy",
          voiceBackend: "voicestudio",
          config: { note: "13D seed: default brand narration voice" },
        },
      }),
    );
    console.log("[13d-b] created voiceover agent", agent.id);
  } else {
    console.log("[13d-b] reused voiceover agent", agent.id);
  }

  // 2. Three pronunciation entries (upsert — idempotent).
  const entries: Array<[string, string]> = [
    ["Marketr", "marketer"],
    ["BriefNow", "brief now"],
    ["Hullcheck", "hull check"],
  ];
  await withWorkspaceScope(workspaceId, (tx) =>
    Promise.all(
      entries.map(([term, phonetic]) =>
        tx.pronunciationEntry.upsert({
          where: { workspaceId_term: { workspaceId, term } },
          create: { workspaceId, term, phonetic, source: "knowledge_graph" },
          update: { phonetic },
        }),
      ),
    ),
  );
  console.log("[13d-b] upserted 3 pronunciation entries");

  // 3. One READY voiceover job with a REAL wav from the live VoiceStudio backend.
  const SEED_TAG = "[13d-seed]";
  await withWorkspaceScope(workspaceId, (tx) =>
    tx.voiceoverJob.deleteMany({
      where: { workspaceId, script: { startsWith: SEED_TAG } },
    }),
  );
  const h = await health();
  console.log(`[13d-b] VoiceStudio backend OK (v${h.version}, device ${h.device})`);

  // Short on purpose: the box renders on CPU with a single worker and the
  // backend abandons generations past ~600s of compute — keep seeds small.
  const script = `${SEED_TAG} Marketr turns your marketing into a growth engine.`;
  // Pronunciation snapshot, as the render pipeline would record it.
  const rendered = script.replace(/\bMarketr\b/g, "marketer");
  // CPU reality (measured 2026-09-28): the serial CPU engine needs minutes
  // per synthesis on this box — allow 15 min rather than timing out.
  const audio = await synthesizeWithKnownVoice({
    voice: "alloy",
    input: rendered,
    timeoutMs: 900_000,
  });
  if (audio.length === 0) throw new Error("VoiceStudio returned empty audio — refusing to seed.");
  console.log(`[13d-b] synthesized ${audio.length} bytes of real VoiceStudio audio`);

  const adapter = new LocalDiskAdapter();
  const key = randomUUID();
  await adapter.put(key, audio, "audio/wav");

  const job = await withWorkspaceScope(workspaceId, (tx) =>
    tx.voiceoverJob.create({
      data: {
        workspaceId,
        agentId: agent.id,
        script,
        voiceId: "alloy",
        voiceBackend: "voicestudio",
        pronunciation: [{ term: "Marketr", phonetic: "marketer" }],
        audioRef: key,
        status: "ready",
        progress: 1,
      },
    }),
  );
  console.log("[13d-b] seeded ready voiceover job", job.id, "audioRef", key);
}

// ---------------------------------------------------------------------------
// [13D-A] Worker A (lead follow-up): consent-gated demo rows.
// ---------------------------------------------------------------------------
{
  const { createAgent, listAgents } = await import("@/lib/voice/agents");
  const { createDraftScript, submitForReview, approveScript } = await import(
    "@/lib/voice/scripts"
  );
  const { upsertConsent } = await import("@/lib/voice/consent");
  const {
    requestSession,
    appendTranscriptTurn,
    setOutcome,
  } = await import("@/lib/voice/sessions");
  const { createLeadRecord } = await import("@/lib/crm/leads");

  const SEED_TAG = "[13d-a seed]";

  // Pipeline (find-or-create).
  let pipeline = await withWorkspaceScope(workspaceId, (tx) =>
    tx.pipeline.findFirst({ where: { workspaceId, name: "Voice seed" }, select: { id: true } }),
  );
  if (!pipeline) {
    pipeline = await withWorkspaceScope(workspaceId, (tx) =>
      tx.pipeline.create({
        data: {
          workspaceId,
          name: "Voice seed",
          stages: [{ id: "new", label: "New" }, { id: "contacted", label: "Contacted" }],
        },
        select: { id: true },
      }),
    );
  }

  // 1. One followup agent (find-or-create).
  const existingAgents = await listAgents(workspaceId);
  type AgentRow = Awaited<ReturnType<typeof listAgents>>[number];
  let agent: AgentRow | undefined = existingAgents.find((a) => a.purpose === "followup");
  if (!agent) {
    agent = (await createAgent(workspaceId, {
      name: "SDR One",
      purpose: "followup",
      voiceId: "alloy",
      voiceBackend: "voicestudio",
      config: {
        escalationRules: ["prospect is upset", "legal or compliance question"],
        maxAttemptsPerLead: 3,
        language: "en",
      },
    })) as unknown as AgentRow;
    console.log("[13d-a] created followup agent", agent.id);
  } else {
    console.log("[13d-a] reused followup agent", agent.id);
  }
  const agentId = agent.id;

  // 2. One approved script WITH the AI disclosure.
  const approvedScripts = await withWorkspaceScope(workspaceId, (tx) =>
    tx.callScript.findMany({
      where: { workspaceId, agentId, status: "approved" },
      select: { id: true },
      take: 1,
    }),
  );
  let scriptId: string;
  if (approvedScripts.length > 0) {
    scriptId = approvedScripts[0]!.id;
    console.log("[13d-a] reused approved script", scriptId);
  } else {
    const draft = await createDraftScript(workspaceId, {
      agentId,
      name: "Intro follow-up",
      body: {
        opening:
          "Hi, I'm an AI assistant calling on behalf of Launchabl. Do you have two minutes about your marketing pipeline?",
        branches: [
          { if: "prospect asks who this is", then: "I'm an AI assistant calling on behalf of Launchabl." },
        ],
        objectionHandlers: [
          { objection: "not interested", response: "Totally fair — can I ask what's not a fit so we don't call again?" },
          { objection: "send an email", response: "Happy to. What's the best email?" },
        ],
        closing: "Thanks for your time — I'll follow up by email.",
      },
    });
    await submitForReview(workspaceId, draft.id);
    const approved = await approveScript(workspaceId, draft.id, userId);
    scriptId = approved.id;
    console.log("[13d-a] created + approved script", scriptId);
  }

  // 3. Two leads: one opted-in for voice, one not.
  async function findOrCreateLead(name: string, email: string, phone: string) {
    const existing = await withWorkspaceScope(workspaceId, (tx) =>
      tx.lead.findFirst({ where: { workspaceId, name }, select: { id: true } }),
    );
    if (existing) return existing.id;
    const res = await createLeadRecord(workspaceId, userId, {
      pipelineId: pipeline!.id,
      name,
      email,
      phone,
      stage: "new",
      source: "other",
    });
    if (!res.ok) throw new Error(`lead seed failed: ${res.error}`);
    return res.lead.id;
  }
  const consentedLeadId = await findOrCreateLead(
    `${SEED_TAG} Priya Shah`,
    "priya.seed@example.com",
    "+15550103111",
  );
  const noConsentLeadId = await findOrCreateLead(
    `${SEED_TAG} Marcus Webb`,
    "marcus.seed@example.com",
    "+15550103222",
  );
  await upsertConsent(workspaceId, consentedLeadId, "voice", "opted_in", "web_form");
  // "pending" is not a human opt action, so upsertConsent (opted_in/opted_out
  // only) can't write it — seed it directly to model a lead with no consent.
  await withWorkspaceScope(workspaceId, (tx) =>
    tx.contactConsent.upsert({
      where: {
        workspaceId_leadId_channel: { workspaceId, leadId: noConsentLeadId, channel: "voice" },
      },
      update: { status: "pending", source: "import" },
      create: {
        workspaceId,
        leadId: noConsentLeadId,
        channel: "voice",
        status: "pending",
        source: "import",
      },
    }),
  );
  console.log("[13d-a] two leads seeded (one opted_in, one pending)");

  // 4a. Consented lead → passes all four gates → rehearsal session w/ transcript.
  const ok = await requestSession(
    workspaceId,
    { agentId, leadId: consentedLeadId, scriptId, channel: "voice" },
    { actorUserId: userId },
  );
  if (ok.blocked) throw new Error(`seed session wrongly blocked: ${ok.blockReason}`);
  console.log("[13d-a] rehearsal session", ok.session.id, "status", ok.session.status);
  await appendTranscriptTurn(workspaceId, ok.session.id, {
    role: "agent",
    text: "Hi, I'm an AI assistant calling on behalf of Launchabl. Do you have two minutes about your marketing pipeline?",
  });
  await appendTranscriptTurn(workspaceId, ok.session.id, {
    role: "prospect",
    text: "Sure, what does Launchabl do?",
  });
  await appendTranscriptTurn(workspaceId, ok.session.id, {
    role: "agent",
    text: "We're a growth agency that turns your marketing into a growth engine. Who owns marketing on your team?",
  });
  await appendTranscriptTurn(workspaceId, ok.session.id, {
    role: "prospect",
    text: "That's me, actually. Send me the details and let's talk next week.",
  });
  await setOutcome(workspaceId, ok.session.id, "callback", { actorUserId: userId });
  console.log("[13d-a] transcript appended, outcome=callback");

  // 4b. Non-consented lead → hard refusal, persisted as blocked w/ blockReason.
  const refused = await requestSession(
    workspaceId,
    { agentId, leadId: noConsentLeadId, scriptId, channel: "voice" },
    { actorUserId: userId },
  );
  if (!refused.blocked) throw new Error("seed: non-consented lead should have been refused");
  console.log("[13d-a] blocked session", refused.session.id, "reason", refused.blockReason);
}

await prisma.$disconnect();
console.log("seed-phase13d-shots done");
