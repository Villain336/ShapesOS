// Phase 19B (WS=panel) — the Dress Rehearsal service against real Postgres,
// as the least-privilege app role, with the labelled FAKE model and the FAKE
// 384-d embedder (no model download, nothing spent):
//   - the entitlement gate: below Pro every call is a 403 with the upgrade
//     message; Pro and trial pass;
//   - interviews in: an upload (text / VTT), a paste, a Meet transcript and a
//     Note, stored verbatim; another workspace never sees them;
//   - personas: derived from interviews under a confirmed credit cap (each
//     cites its interview), a cap too small stops before any call, founder
//     edit + veto, a hand-made persona is uncalibrated.
// Run: DATABASE_URL=<app role> npx tsx --test lib/panel/__tests__/service-db.test.ts

import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { EntitlementError } from "@/lib/billing/entitlements";
import { createNote } from "@/lib/notes/service";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { lexicalTestEmbedder } from "../memory";
import { testPanelDeps } from "../deps.server";
import {
  addInterview,
  addManualPersona,
  derivePersonas,
  editPersona,
  estimatePersonaDerivation,
  importInterviewFile,
  importInterviewFromMeeting,
  importInterviewFromNote,
  listInterviews,
  listPersonas,
  setPersonaStatus,
  type PanelActor,
} from "../service.server";
import { INTERVIEW_TEXT, validSpec } from "./fixtures";

const RUN = randomUUID().slice(0, 8);
const WS = `p19bsv-${RUN}`;
const WS_STARTER = `p19bsvs-${RUN}`;
const ED = `p19bsv-ed-${RUN}`;
const ed: PanelActor = { workspaceId: WS, userId: ED, role: "editor" };
const starter: PanelActor = { workspaceId: WS_STARTER, userId: ED, role: "editor" };
const deps = testPanelDeps({ embed: lexicalTestEmbedder });

const SAM_VTT = `WEBVTT

00:00:01.000 --> 00:00:03.000
<v Interviewer>What matters to you when you pick a tool?

00:00:03.500 --> 00:00:09.000
<v Sam Ortiz>I'm the founder of a two-person studio and I pay with my own money. I can never go above $30 a month.

00:00:09.500 --> 00:00:12.000
<v Sam Ortiz>Annual billing is a non-starter for me because cash flow is tight.
`;

before(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, WS_STARTER] } } });
  await prisma.workspace.create({ data: { id: WS, name: `Panel ${RUN}`, ownerUserId: ED, plan: "pro" } });
  await prisma.workspace.create({ data: { id: WS_STARTER, name: `Starter ${RUN}`, ownerUserId: ED, plan: "starter" } });
  await prisma.workspaceMember.createMany({ data: [{ workspaceId: WS, userId: ED, role: "editor", email: `ed-${RUN}@example.test` }, { workspaceId: WS_STARTER, userId: ED, role: "editor", email: `ed-${RUN}@example.test` }] });
});

after(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, WS_STARTER] } } });
  await prisma.$disconnect();
});

describe("entitlement gate (dress_rehearsal, Pro and above)", () => {
  it("below Pro, every call is a 403 with the upgrade message", async () => {
    for (const call of [() => listInterviews(starter), () => addInterview(starter, { title: "x", text: "hello there" }, deps), () => listPersonas(starter)]) {
      await assert.rejects(call(), (e: unknown) => e instanceof EntitlementError && e.status === 403 && /Dress rehearsal isn't included in your plan\. Upgrade to Pro/.test(e.message));
    }
  });
});

let priyaId = "";
let samId = "";

describe("interviews in", () => {
  it("an upload is stored verbatim; a VTT becomes speaker turns", async () => {
    const priya = await importInterviewFile(ed, { filename: "priya.txt", bytes: Buffer.from(INTERVIEW_TEXT), interviewee: "Priya Nair" }, deps);
    const sam = await importInterviewFile(ed, { filename: "sam.vtt", bytes: Buffer.from(SAM_VTT), interviewee: "Sam Ortiz" }, deps);
    priyaId = priya.id;
    samId = sam.id;
    const list = await listInterviews(ed);
    assert.deepEqual(list.map((t) => t.title).sort(), ["priya.txt", "sam.vtt"]);
    const full = await prisma.$transaction(async () => withWorkspaceScope(WS, (tx) => tx.panelTranscript.findFirstOrThrow({ where: { id: sam.id } })));
    assert.equal(full.text.split("\n")[1], "Sam Ortiz: I'm the founder of a two-person studio and I pay with my own money. I can never go above $30 a month. Annual billing is a non-starter for me because cash flow is tight.");
    assert.equal(sam.source, "upload");
  });

  it("a Meet transcript and a Note can be reused as interviews", async () => {
    await withWorkspaceScope(WS, (tx) =>
      tx.meetingSession.create({ data: { id: `m-${RUN}`, workspaceId: WS, title: "Discovery call with Lee", roomName: `room-${RUN}`, startedBy: ED, transcript: "Lee: We tried three tools and they all hid the real price.", transcriptSource: "pasted" } }),
    );
    const fromMeet = await importInterviewFromMeeting(ed, `m-${RUN}`, deps);
    assert.deepEqual([fromMeet.source, fromMeet.sourceRef, fromMeet.title], ["meet", `m-${RUN}`, "Discovery call with Lee"]);
    const note = await createNote({ workspaceId: WS, createdBy: ED, title: "Call notes: Kim", body: "Kim said the onboarding promised a day and took a month.", shareState: "private" });
    const fromNote = await importInterviewFromNote(ed, note.id, deps);
    assert.equal(fromNote.source, "note");
    // Someone else's private note is not theirs to reuse.
    await assert.rejects(importInterviewFromNote({ ...ed, userId: `other-${RUN}` }, note.id, deps), /not found/i);
  });

  it("an empty paste is refused with the reason", async () => {
    await assert.rejects(addInterview(ed, { title: "blank", text: "   " }, deps), /empty/);
  });
});

describe("personas", () => {
  it("the derivation estimate is shown before anything runs", async () => {
    const e = await estimatePersonaDerivation(ed, [priyaId, samId], deps);
    assert.equal(e.transcripts, 2);
    assert.ok(e.total > 0);
  });

  it("a cap below the estimate's first call stops before any model call", async () => {
    const res = await derivePersonas(ed, { transcriptIds: [priyaId], capCredits: 0 }, deps);
    assert.deepEqual([res.personas.length, res.stoppedAtCap, res.spentCredits], [0, true, 0]);
  });

  it("derives one calibrated persona per interview, each citing its interview", async () => {
    const res = await derivePersonas(ed, { transcriptIds: [priyaId, samId], capCredits: 1000 }, deps);
    assert.equal(res.stoppedAtCap, false);
    assert.deepEqual(res.personas.map((p) => p.name).sort(), ["Priya Nair", "Sam Ortiz"]);
    for (const p of res.personas) {
      assert.equal(p.calibrated, true);
      assert.equal(p.sourceTranscriptIds.length, 1);
      assert.ok(p.spec.knownObjections.every((o) => o.sourceTranscriptId === p.sourceTranscriptIds[0]));
    }
    assert.ok(res.spentCredits > 0 && res.spentCredits <= 1000);
  });

  it("the founder edits and vetoes; a bad edit is refused", async () => {
    const sam = (await listPersonas(ed)).find((p) => p.name === "Sam Ortiz")!;
    const edited = await editPersona(ed, sam.id, { budget: { monthlyMax: 25 } });
    assert.equal(edited.spec.budget.monthlyMax, 25);
    await assert.rejects(editPersona(ed, sam.id, { skepticism: 7 }), /skepticism/);
    const vetoed = await setPersonaStatus(ed, sam.id, "vetoed");
    assert.equal(vetoed.status, "vetoed");
    await setPersonaStatus(ed, sam.id, "active");
  });

  it("a hand-made persona is uncalibrated (it can walk, it will get no verdict)", async () => {
    const p = await addManualPersona(ed, validSpec({ identity: { name: "Manual Mo", role: "Buyer" }, sourceTranscriptIds: [] }));
    assert.equal(p.calibrated, false);
    assert.equal(p.origin, "manual");
  });

  it("a viewer can read but not change personas", async () => {
    const viewer: PanelActor = { ...ed, role: "viewer" };
    assert.ok((await listPersonas(viewer)).length >= 3);
    await assert.rejects(addManualPersona(viewer, validSpec()), (e: unknown) => (e as { status?: number }).status === 403);
  });
});
