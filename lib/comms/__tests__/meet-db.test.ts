// ShapesOS — Phase 18.2 (WS=comms) DB test: Meet.
//   - a meeting started in a private channel is seen only by that channel's
//     members (list, detail, join, Calendar); the channel gets a "Started a
//     call" message with the meeting to join; another workspace never sees it;
//   - joining: 409 "not configured" in rehearsal mode (the default — no
//     token is minted); with LiveKit configured, a participant token for the
//     meeting's own room; never after it ended; only the starter or an admin
//     ends it;
//   - transcripts are post-call: pasted (editor+), or an uploaded recording
//     through the transcriber (409 when no key — never a fake transcript);
//   - the meeting agent: a live summary saves once into a Univer notes doc
//     (shared with the workspace) and the chosen action items as MY
//     reminders (due 09:00 in my zone, sourceRef meeting:<id>) or tasks in an
//     ops project (assigned to the member named); a mock summary saves
//     nothing; a viewer can't.
// Real Postgres as the least-privilege app role; the model, the transcriber
// and the token mint are stubs passed in (deps).
// Run: DATABASE_URL=<app role> npx tsx --test lib/comms/__tests__/meet-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { MeetCtx } from "../meet/meet.server";

process.env.SPOTLIGHT_INDEX_ON_WRITE = "off";

const RUN = randomUUID().slice(0, 8);
const WS = `p182-meet-${RUN}`;
const WS_B = `p182-meet-b-${RUN}`;
const ANA = `p182-meet-ana-${RUN}`; // owner
const BEN = `p182-meet-ben-${RUN}`; // editor
const VI = `p182-meet-vi-${RUN}`; // viewer

let prisma: typeof import("@/lib/prisma").prisma;
let rls: typeof import("@/lib/substrate/memory/rls");
let meet: typeof import("../meet/meet.server");
let msgs: typeof import("../messages/store.server");
type Tx = import("@prisma/client").Prisma.TransactionClient;
const inWs = <T,>(ws: string, fn: (tx: Tx) => Promise<T>) => rls.withWorkspaceScope(ws, (tx) => fn(tx as Tx));

const ctx = (userId: string, role: MeetCtx["role"], name: string, ws = WS): MeetCtx => ({ workspaceId: ws, userId, role, name, email: `${name.toLowerCase()}-${RUN}@example.com` });
const anaC = () => ctx(ANA, "owner", "Ana");
const benC = () => ctx(BEN, "editor", "Ben");
const viC = () => ctx(VI, "viewer", "Vi");

async function status(p: Promise<unknown>): Promise<number | "ok"> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
}

const ids: Record<string, string> = {};

before(async () => {
  ({ prisma } = await import("@/lib/prisma"));
  rls = await import("@/lib/substrate/memory/rls");
  meet = await import("../meet/meet.server");
  msgs = await import("../messages/store.server");
  for (const ws of [WS, WS_B]) await prisma.workspace.create({ data: { id: ws, name: ws, ownerUserId: ANA } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: ANA, role: "owner", name: "Ana", email: `ana-${RUN}@example.com` },
      { workspaceId: WS, userId: BEN, role: "editor", name: "Ben Ode", email: `ben-${RUN}@example.com` },
      { workspaceId: WS, userId: VI, role: "viewer", name: "Vi", email: `vi-${RUN}@example.com` },
      { workspaceId: WS_B, userId: ANA, role: "owner", name: "Ana" },
    ],
  });
  ids.secret = (await msgs.createChannel(anaC(), { name: "leadership", isPrivate: true, members: [`user:${BEN}`] })).id;
  ids.ops = (await inWs(WS, (tx) => tx.opsProject.create({ data: { workspaceId: WS, name: `Launch ${RUN}` } }))).id;
});

after(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, WS_B] } } });
  await prisma.$disconnect();
});

describe("who sees a meeting", () => {
  it("a private channel's call: its members only (list, detail, join, calendar); the channel gets a Join message", async () => {
    const m = await meet.startMeeting(benC(), { title: "Board prep", origin: "channel", originRef: ids.secret });
    ids.private = m.id;
    assert.equal(m.channel?.id, ids.secret);
    assert.equal(m.roomName, `meet-${WS.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40)}-${m.id}`);
    const posted = (await msgs.listMessages(anaC(), ids.secret!)).messages.find((x) => x.call?.meetingId === m.id);
    assert.ok(posted, "the channel hears about it");
    assert.equal(posted!.body, "Started a call: Board prep");

    assert.ok((await meet.listMeetings(anaC())).some((x) => x.id === m.id));
    assert.ok(!(await meet.listMeetings(viC())).some((x) => x.id === m.id), "not a member of the channel");
    assert.equal(await status(meet.getMeeting(viC(), m.id)), 404);
    assert.equal(await status(meet.joinMeeting(viC(), m.id)), 404);
    assert.equal(await status(meet.startMeeting(viC(), { origin: "channel", originRef: ids.secret })), 404, "can't start a call in a channel you can't see");
    assert.equal((await meet.listMeetings(ctx(ANA, "owner", "Ana", WS_B))).length, 0, "another workspace");
    assert.equal(await inWs(WS_B, (tx) => tx.meetingSession.count({ where: { id: m.id } })), 0, "FORCE RLS");

    // Calendar: a channel call shows only for the person who started it.
    const { loadCalendarEvents } = await import("../calendar/sources.server");
    const from = new Date(Date.now() - 3_600_000);
    const to = new Date(Date.now() + 3_600_000);
    const benCal = await loadCalendarEvents({ workspaceId: WS, userId: BEN, timeZone: "UTC" }, from, to, { include: ["meeting"] });
    const viCal = await loadCalendarEvents({ workspaceId: WS, userId: VI, timeZone: "UTC" }, from, to, { include: ["meeting"] });
    assert.ok(benCal.events.some((e) => e.id === `meeting:${m.id}`));
    assert.ok(!viCal.events.some((e) => e.id === `meeting:${m.id}`), "a private channel's call title never shows in someone else's calendar");

    const adhoc = await meet.startMeeting(viC(), { title: "Coffee" });
    assert.equal(adhoc.origin, "adhoc");
    assert.ok((await meet.listMeetings(benC())).some((x) => x.id === adhoc.id), "an ad hoc meeting is the workspace's");
    assert.equal(await status(meet.startMeeting(anaC(), { origin: "calendar", originRef: "javascript:alert(1)" })), 400);
    ids.adhoc = adhoc.id;
  });
});

describe("joining", () => {
  it("rehearsal: 409 and no token; configured: a token for the meeting's room; never after it ends", async () => {
    let minted = 0;
    const off: import("../meet/meet.server").JoinDeps = {
      state: async () => ({ configured: false, mode: "rehearsal", reason: "VOICE_LIVEKIT_MODE is rehearsal (the default)." }),
      mint: async () => {
        minted++;
        return { url: "wss://x", token: "t" };
      },
    };
    const r = await meet.joinMeeting(anaC(), ids.adhoc!, off).catch((e) => e);
    assert.equal(r.status, 409);
    assert.equal(r.code, "livekit_not_configured");
    assert.equal(minted, 0, "no token is minted");
    const real = await meet.liveKitState({ VOICE_LIVEKIT_MODE: "rehearsal" } as NodeJS.ProcessEnv);
    assert.deepEqual([real.configured, real.mode], [false, "rehearsal"]);
    const broken = await meet.liveKitState({ VOICE_LIVEKIT_MODE: "cloud" } as NodeJS.ProcessEnv);
    assert.deepEqual([broken.configured, broken.mode], [false, "misconfigured"]);

    const rooms: string[] = [];
    const on: import("../meet/meet.server").JoinDeps = {
      state: async () => ({ configured: true, mode: "cloud", reason: null }),
      mint: async (room, identity, name) => {
        rooms.push(`${room}|${identity}|${name}`);
        return { url: "wss://lk.example", token: "jwt" };
      },
    };
    const j = await meet.joinMeeting(benC(), ids.private!, on);
    assert.equal(j.url, "wss://lk.example");
    assert.equal(rooms[0], `${j.roomName}|user-${BEN}|Ben`);

    assert.equal(await status(meet.endMeeting(benC(), ids.adhoc!)), 403, "only the starter or an admin ends it");
    await meet.endMeeting(viC(), ids.adhoc!);
    assert.equal(await status(meet.joinMeeting(anaC(), ids.adhoc!, on)), 409, "ended");
    assert.equal((await meet.getMeeting(anaC(), ids.adhoc!)).status, "ended");
  });
});

describe("transcripts and the meeting agent", () => {
  const transcript = "Ana: Let's ship on Friday.\nBen: I'll send the deck by October 9.\nAna: Agreed.";
  const live = (text: string): import("../meet/meet.server").SummaryDeps => ({ generate: async () => ({ text, live: true }) });

  it("post-call transcripts: pasted by an editor; a recording needs the transcription service", async () => {
    assert.equal(await status(meet.saveTranscript(viC(), ids.private!, { text: transcript, source: "pasted" })), 403);
    assert.equal(await status(meet.summarizeMeeting(benC(), ids.private!, live("{}"))), 400, "needs a transcript first");
    const noKey: import("../meet/meet.server").TranscribeDeps = {
      transcribe: async () => {
        const e = new Error("no key");
        e.name = "TranscriptionNotConfiguredError";
        throw e;
      },
    };
    const r = await meet.transcribeRecording(benC(), ids.private!, { audio: Buffer.from("abc"), fileName: "call.m4a", mimeType: "audio/mp4" }, noKey).catch((e) => e);
    assert.equal(r.status, 409);
    assert.equal(r.code, "transcription_not_configured");
    assert.equal(await status(meet.transcribeRecording(benC(), ids.private!, { audio: Buffer.from("abc"), fileName: "x.pdf", mimeType: "application/pdf" }, noKey)), 400);
    let seen: { fileName: string; mimeType: string } | null = null;
    const whisper: import("../meet/meet.server").TranscribeDeps = {
      transcribe: async (_a, opts) => {
        seen = opts;
        return { text: transcript, live: true };
      },
    };
    const m = await meet.transcribeRecording(benC(), ids.private!, { audio: Buffer.from("abc"), fileName: "call.m4a", mimeType: "audio/mp4" }, whisper);
    assert.deepEqual(seen, { fileName: "call.m4a", mimeType: "audio/mp4" }, "the recording's own format reaches the service");
    assert.equal(m.transcriptSource, "uploaded");
    assert.equal(m.transcript, transcript);
  });

  it("a mock summary saves nothing; a live one saves the notes doc and the chosen items once", async () => {
    const mock = await meet.summarizeMeeting(benC(), ids.private!, { generate: async () => ({ text: '{"notes":"MOCK","decisions":[],"actionItems":[{"title":"x"}]}', live: false }) });
    assert.equal(mock.summary?.mock, true);
    const prose = await meet.summarizeMeeting(benC(), ids.private!, { generate: async () => ({ text: "[mock] I would summarize this meeting.", live: false }) });
    assert.equal(prose.summary?.mock, true, "a mock model's prose becomes a labelled mock summary, not an error");
    assert.equal(prose.summary?.actionItems.length, 0);
    const bad = await meet.summarizeMeeting(benC(), ids.private!, { generate: async () => ({ text: "not json", live: true }) }).catch((e) => e);
    assert.equal(bad.status, 502, "a live model's unreadable answer is an error, never invented");
    assert.equal(await status(meet.applySummary(benC(), ids.private!, { saveDoc: true, items: [{ index: 0, target: "reminder" }] })), 409, "never saved from a mock");

    const answer = JSON.stringify({
      notes: "We agreed to ship on Friday.",
      decisions: ["Ship on Friday"],
      actionItems: [
        { title: "Send the deck", owner: "Ben", due: "2026-10-09" },
        { title: "Book the launch room", owner: "Ana", due: null },
        { title: "Not needed", owner: null, due: null },
      ],
    });
    const m = await meet.summarizeMeeting(benC(), ids.private!, live(`Sure!\n${answer}`));
    assert.equal(m.summary?.mock, false);
    assert.equal(m.summary?.actionItems.length, 3);
    assert.equal(await status(meet.applySummary(viC(), ids.private!, { saveDoc: true, items: [] })), 403, "a viewer can't (checked before anything about the meeting)");
    assert.equal(await status(meet.applySummary(benC(), ids.private!, { saveDoc: true, items: [{ index: 0, target: "task", opsProjectId: "nope" }] })), 400, "a real ops project");

    const tz: import("../meet/meet.server").ApplyDeps = { ...meet.defaultApplyDeps, timeZone: async () => "America/New_York" };
    const applied = await meet.applySummary(
      benC(),
      ids.private!,
      { saveDoc: true, items: [{ index: 0, target: "reminder" }, { index: 1, target: "task", opsProjectId: ids.ops }, { index: 2, target: "skip" }] },
      tz,
    );
    assert.ok(applied.notesDocId, "a notes doc");
    const doc = await inWs(WS, (tx) => tx.univerDoc.findUnique({ where: { id: applied.notesDocId! } }));
    assert.equal(doc?.kind, "doc");
    assert.equal(doc?.shareState, "workspace");
    assert.equal(doc?.sourceRef, `meeting:${ids.private}`);
    assert.match(JSON.stringify(doc?.snapshot), /Ship on Friday/);

    const reminders = await inWs(WS, (tx) => tx.opsTask.findMany({ where: { workspaceId: WS, projectId: null, assigneeId: BEN, sourceRef: `meeting:${ids.private}` } }));
    assert.equal(reminders.length, 1);
    assert.equal(reminders[0]!.title, "Send the deck");
    assert.equal(reminders[0]!.dueAt?.toISOString(), "2026-10-09T13:00:00.000Z", "09:00 in New York");
    const tasks = await inWs(WS, (tx) => tx.opsTask.findMany({ where: { workspaceId: WS, projectId: ids.ops } }));
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.title, "Book the launch room");
    assert.equal(tasks[0]!.assigneeId, ANA, "assigned to the member the item names");
    assert.deepEqual([applied.summary?.applied?.reminders.length, applied.summary?.applied?.tasks.length], [1, 1]);

    assert.equal(await status(meet.applySummary(benC(), ids.private!, { saveDoc: true, items: [] }, tz)), 409, "once");
    assert.equal(await status(meet.summarizeMeeting(benC(), ids.private!, live(answer))), 409, "the saved record stays");
    assert.equal(await status(meet.saveTranscript(benC(), ids.private!, { text: "again", source: "pasted" })), 409);
  });
});
