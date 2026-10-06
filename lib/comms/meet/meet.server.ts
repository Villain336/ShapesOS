// ShapesOS — Phase 18.2 (WS=comms): Meet — video meetings on LiveKit, and
// the meeting agent that turns a finished call into notes, decisions and
// action items.
//
// Rooms: livekit-client in the browser + a server-minted participant token
// (lib/voice/livekit.ts resolveLiveKitConfig / mintSessionToken). People
// joining a WebRTC room is not dialing: nothing here places a phone call,
// LIVE_DIALING is untouched, and no voice-agent worker is started. When
// LiveKit is not configured (VOICE_LIVEKIT_MODE=rehearsal, the default, or
// missing credentials) the app says so — meetings can still be planned and
// transcripts turned into notes, but nobody can join a room.
//
// Transcripts are POST-CALL only: an uploaded recording (transcribed by the
// Whisper provider, lib/clipper/transcribe.ts — an honest error when no key
// is set) or pasted text. Nothing records during the call. Zoom / Google
// Meet recording imports are a seam for Phase 18.5 (model.ts).
//
// The meeting agent (the workspace's background model, metered) writes the
// summary; a person then chooses which action items become their reminders
// (Reminders, sourceRef "meeting:<id>") or tasks in an ops project, and the
// notes become a note in the Notes app (lib/notes createNote, sourceRef
// "meeting:<id>", linked to the ops projects its tasks went to): shared with
// the workspace, or private to the person who saved it when the call was in
// a private channel or a DM. A mock model's summary is labelled and can't be
// saved (no fake records).
//
// Who sees a meeting: one started from a channel, the people who can see
// that channel; any other, every member of the workspace (404 otherwise).

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { HttpError } from "@/lib/api/errors";
import { roleAtLeast } from "@/lib/authz";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { createNote, type CreateNoteInput } from "@/lib/notes/service";
import { canSee, workspaceMembers, type MessagesCtx } from "../messages/store.server";
import { userKey } from "../messages/model";
import {
  dueToUtc,
  isMeetingOrigin,
  matchOwner,
  MAX_RECORDING_BYTES,
  MAX_TRANSCRIPT_CHARS,
  meetingRoomName,
  notesMarkdown,
  parseMeetingSummary,
  summaryPrompt,
  validCalendarRef,
  type MeetingOrigin,
  type MeetingSummary,
} from "./model";

type Tx = Prisma.TransactionClient;
export type MeetCtx = MessagesCtx;

const scoped = <T>(ctx: { workspaceId: string }, fn: (tx: Tx) => Promise<T>) => withWorkspaceScope(ctx.workspaceId, (tx) => fn(tx as Tx));

export interface LiveKitState {
  configured: boolean;
  mode: "rehearsal" | "self-hosted" | "cloud" | "misconfigured";
  /** Why calls can't be joined (null when configured). */
  reason: string | null;
}

export async function liveKitState(env: NodeJS.ProcessEnv = process.env): Promise<LiveKitState> {
  const { resolveLiveKitConfig } = await import("@/lib/voice/livekit");
  try {
    const cfg = resolveLiveKitConfig(env);
    if (cfg.mode === "rehearsal") return { configured: false, mode: "rehearsal", reason: "VOICE_LIVEKIT_MODE=rehearsal, the default" };
    return { configured: true, mode: cfg.mode, reason: null };
  } catch (err) {
    return { configured: false, mode: "misconfigured", reason: (err instanceof Error ? err.message : "LiveKit is not configured").replace(/[.\s]+$/, "") };
  }
}

export interface StoredSummary extends MeetingSummary {
  mock: boolean;
  at: string;
  by: string;
  applied?: { at: string; by: string; docId: string | null; reminders: string[]; tasks: string[] } | null;
}

export interface MeetingView {
  id: string;
  title: string;
  origin: MeetingOrigin;
  originRef: string | null;
  channel: MeetingChannel | null;
  roomName: string;
  startedBy: string;
  startedByName: string;
  status: "open" | "ended";
  startedAt: string;
  endedAt: string | null;
  transcriptSource: string;
  hasTranscript: boolean;
  transcript?: string | null;
  summary: StoredSummary | null;
  /** The meeting's note in the Notes app (a UniverDoc of kind "note"; the column predates Notes). */
  notesDocId: string | null;
  canManage: boolean;
}

export interface MeetingChannel {
  id: string;
  name: string;
  kind: string;
  /** Only its members see it (a private channel, a DM or a group). */
  private: boolean;
}

type Row = Prisma.MeetingSessionGetPayload<object>;

async function channelsFor(tx: Tx, ctx: MeetCtx, ids: string[]) {
  if (!ids.length) return new Map<string, MeetingChannel & { visible: boolean }>();
  const rows = await tx.chatChannel.findMany({ where: { workspaceId: ctx.workspaceId, id: { in: ids } }, select: { id: true, name: true, kind: true, isPrivate: true } });
  const mine = new Set(
    (await tx.chatChannelMember.findMany({ where: { workspaceId: ctx.workspaceId, channelId: { in: ids }, memberKey: userKey(ctx.userId) }, select: { channelId: true } })).map((m) => m.channelId),
  );
  return new Map(
    rows.map((c) => [
      c.id,
      { id: c.id, name: c.kind === "channel" ? `#${c.name}` : c.kind === "dm" ? "Direct message" : c.name, kind: c.kind, private: !canSee(c, false), visible: canSee(c, mine.has(c.id)) },
    ]),
  );
}

function view(r: Row, ctx: MeetCtx, names: Map<string, string>, channel: MeetingChannel | null, detail: boolean): MeetingView {
  return {
    id: r.id,
    title: r.title,
    origin: isMeetingOrigin(r.origin) ? r.origin : "adhoc",
    originRef: r.originRef,
    channel,
    roomName: r.roomName,
    startedBy: r.startedBy,
    startedByName: names.get(r.startedBy) ?? "Former member",
    status: r.status === "ended" ? "ended" : "open",
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt?.toISOString() ?? null,
    transcriptSource: r.transcriptSource,
    hasTranscript: !!r.transcript?.trim(),
    ...(detail ? { transcript: r.transcript } : {}),
    summary: (r.summary as StoredSummary | null) ?? null,
    notesDocId: r.notesDocId,
    canManage: r.startedBy === ctx.userId || roleAtLeast(ctx.role, "admin"),
  };
}

async function memberNames(workspaceId: string): Promise<Map<string, string>> {
  return new Map((await workspaceMembers(workspaceId)).map((m) => [m.userId, (m.name ?? "").trim() || (m.email ? m.email.split("@")[0]! : "Member")]));
}

/** The meeting if this member may see it (404 otherwise). */
async function meetingFor(tx: Tx, ctx: MeetCtx, id: string): Promise<{ row: Row; channel: MeetingChannel | null }> {
  const row = await tx.meetingSession.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
  if (!row) throw new HttpError(404, "Meeting not found.");
  if (row.origin === "channel" && row.originRef) {
    const ch = (await channelsFor(tx, ctx, [row.originRef])).get(row.originRef);
    if (!ch?.visible) throw new HttpError(404, "Meeting not found.");
    return { row, channel: { id: ch.id, name: ch.name, kind: ch.kind, private: ch.private } };
  }
  return { row, channel: null };
}

export async function startMeeting(ctx: MeetCtx, input: { title?: string | null; origin?: string | null; originRef?: string | null }): Promise<MeetingView> {
  const origin: MeetingOrigin = isMeetingOrigin(input.origin) ? input.origin : "adhoc";
  const ref = (input.originRef ?? "").trim() || null;
  if (origin === "calendar" && !validCalendarRef(ref)) throw new HttpError(400, "That calendar event can't be found.");
  if (origin === "channel" && !ref) throw new HttpError(400, "Pick the channel to start the call in.");
  const title = (input.title ?? "").trim().slice(0, 200) || "Meeting";
  const id = randomUUID().replace(/-/g, "").slice(0, 24);
  const startedByName = (ctx.name ?? "").trim() || (ctx.email ? ctx.email.split("@")[0]! : "Member");
  const created = await scoped(ctx, async (tx) => {
    let channel: MeetingChannel | null = null;
    if (origin === "channel") {
      const ch = (await channelsFor(tx, ctx, [ref!])).get(ref!);
      if (!ch?.visible) throw new HttpError(404, "Channel not found.");
      channel = { id: ch.id, name: ch.name, kind: ch.kind, private: ch.private };
    }
    const row = await tx.meetingSession.create({
      data: { id, workspaceId: ctx.workspaceId, title, roomName: meetingRoomName(ctx.workspaceId, id), origin, originRef: ref, startedBy: ctx.userId },
    });
    if (channel) {
      // The channel hears about it: a message with a Join button.
      const msg = await tx.teamChatMessage.create({
        data: {
          workspaceId: ctx.workspaceId,
          channelId: channel.id,
          userId: ctx.userId,
          authorName: startedByName,
          authorKind: "user",
          body: `Started a call: ${title}`,
          meta: { kind: "meeting", meetingId: row.id, title },
        },
      });
      await tx.chatChannel.update({ where: { id: channel.id, workspaceId: ctx.workspaceId }, data: { lastMessageAt: msg.createdAt } });
    }
    return { row, channel };
  });
  return view(created.row, ctx, new Map([[ctx.userId, startedByName]]), created.channel, true);
}

export async function listMeetings(ctx: MeetCtx, limit = 50): Promise<MeetingView[]> {
  const names = await memberNames(ctx.workspaceId);
  return scoped(ctx, async (tx) => {
    const rows = await tx.meetingSession.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { startedAt: "desc" }, take: Math.min(Math.max(limit, 1), 200) });
    const chans = await channelsFor(tx, ctx, [...new Set(rows.filter((r) => r.origin === "channel" && r.originRef).map((r) => r.originRef!))]);
    return rows
      .filter((r) => r.origin !== "channel" || (r.originRef && chans.get(r.originRef)?.visible))
      .map((r) => {
        const ch = r.origin === "channel" && r.originRef ? chans.get(r.originRef) : null;
        return view(r, ctx, names, ch ? { id: ch.id, name: ch.name, kind: ch.kind, private: ch.private } : null, false);
      });
  });
}

export async function getMeeting(ctx: MeetCtx, id: string): Promise<MeetingView> {
  const names = await memberNames(ctx.workspaceId);
  return scoped(ctx, async (tx) => {
    const { row, channel } = await meetingFor(tx, ctx, id);
    return view(row, ctx, names, channel, true);
  });
}

export interface JoinDeps {
  state: () => Promise<LiveKitState>;
  mint: (roomName: string, identity: string, name: string) => Promise<{ url: string; token: string }>;
}

export const defaultJoinDeps: JoinDeps = {
  state: () => liveKitState(),
  mint: async (roomName, identity, name) => {
    const { mintSessionToken, resolveLiveKitConfig } = await import("@/lib/voice/livekit");
    const cfg = resolveLiveKitConfig();
    const token = await mintSessionToken(cfg, { roomName, identity, participantName: name }, { ttlSeconds: 2 * 3600 });
    return { url: cfg.url!, token };
  },
};

/** A participant token for this meeting's room (409 when LiveKit is not configured or the meeting ended). */
export async function joinMeeting(ctx: MeetCtx, id: string, deps: JoinDeps = defaultJoinDeps): Promise<{ url: string; token: string; roomName: string; identity: string }> {
  const { row } = await scoped(ctx, (tx) => meetingFor(tx, ctx, id));
  if (row.status === "ended") throw new HttpError(409, "This meeting has ended.");
  const state = await deps.state();
  if (!state.configured) throw new HttpError(409, `Calls are not available on this server: ${state.reason ?? "LiveKit is not configured."}`, { code: "livekit_not_configured" });
  const identity = `user-${ctx.userId}`.slice(0, 120);
  const name = (ctx.name ?? "").trim() || (ctx.email ? ctx.email.split("@")[0]! : "Member");
  const { url, token } = await deps.mint(row.roomName, identity, name);
  return { url, token, roomName: row.roomName, identity };
}

export async function endMeeting(ctx: MeetCtx, id: string): Promise<MeetingView> {
  await scoped(ctx, async (tx) => {
    const { row } = await meetingFor(tx, ctx, id);
    if (row.startedBy !== ctx.userId && !roleAtLeast(ctx.role, "admin")) throw new HttpError(403, "Only the person who started it, or an admin, can end this meeting.");
    if (row.status !== "ended") await tx.meetingSession.update({ where: { id: row.id, workspaceId: ctx.workspaceId }, data: { status: "ended", endedAt: new Date() } });
  });
  return getMeeting(ctx, id);
}

function requireEditor(ctx: MeetCtx) {
  if (!roleAtLeast(ctx.role, "editor")) throw new HttpError(403, "Editors and above can add transcripts and notes.");
}

/** Save a pasted transcript (post-call). */
export async function saveTranscript(ctx: MeetCtx, id: string, input: { text: string; source: "pasted" | "uploaded" }): Promise<MeetingView> {
  requireEditor(ctx);
  const text = (input.text ?? "").trim();
  if (!text) throw new HttpError(400, "The transcript is empty.");
  if (text.length > MAX_TRANSCRIPT_CHARS) throw new HttpError(400, `Transcripts are at most ${MAX_TRANSCRIPT_CHARS} characters.`);
  await scoped(ctx, async (tx) => {
    const { row } = await meetingFor(tx, ctx, id);
    if ((row.summary as StoredSummary | null)?.applied) throw new HttpError(409, "The notes were already saved; start a new meeting record for another transcript.");
    await tx.meetingSession.update({ where: { id: row.id, workspaceId: ctx.workspaceId }, data: { transcript: text, transcriptSource: input.source, summary: Prisma.DbNull } });
  });
  return getMeeting(ctx, id);
}

export interface TranscribeDeps {
  transcribe: (audio: Buffer, opts: { fileName: string; mimeType: string }) => Promise<{ text: string; live: boolean }>;
}

export const defaultTranscribeDeps: TranscribeDeps = {
  transcribe: async (audio, opts) => {
    // getTranscriptionProvider throws TranscriptionNotConfiguredError without a key — never a fake transcript.
    const { getTranscriptionProvider } = await import("@/lib/clipper/transcribe");
    const p = getTranscriptionProvider();
    const out = await p.transcribe(audio, opts);
    return { text: out.text, live: p.isLive };
  },
};

/** Transcribe an uploaded recording (post-call) and save it. */
export async function transcribeRecording(ctx: MeetCtx, id: string, file: { audio: Buffer; fileName: string; mimeType: string }, deps: TranscribeDeps = defaultTranscribeDeps): Promise<MeetingView> {
  requireEditor(ctx);
  if (!file.audio.length) throw new HttpError(400, "The recording is empty.");
  if (file.audio.length > MAX_RECORDING_BYTES) throw new HttpError(413, "Recordings are at most 25 MB (the transcription service's limit). Upload the audio only, or a shorter part.");
  if (!/^(audio|video)\//.test(file.mimeType)) throw new HttpError(400, "Upload an audio or video recording.");
  await scoped(ctx, (tx) => meetingFor(tx, ctx, id));
  let text: string;
  try {
    const out = await deps.transcribe(file.audio, { fileName: file.fileName.replace(/[^\w.-]/g, "_").slice(-80) || "recording.mp3", mimeType: file.mimeType });
    if (!out.live) throw new HttpError(409, "No transcription service is configured, so the recording was not transcribed.");
    text = out.text;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if ((err as Error)?.name === "TranscriptionNotConfiguredError") throw new HttpError(409, "No transcription service is configured (set TRANSCRIPTION_API_KEY). Paste the transcript instead.", { code: "transcription_not_configured" });
    throw new HttpError(502, `The recording couldn't be transcribed: ${err instanceof Error ? err.message.slice(0, 200) : "unknown error"}`);
  }
  return saveTranscript(ctx, id, { text, source: "uploaded" });
}

export interface SummaryDeps {
  generate: (ctx: MeetCtx, prompt: string) => Promise<{ text: string; live: boolean }>;
}

export const defaultSummaryDeps: SummaryDeps = {
  generate: async (ctx, prompt) => {
    const { getLlmProviderForWorkspace } = await import("@/lib/llm/workspace");
    const llm = await getLlmProviderForWorkspace("background", { workspaceId: ctx.workspaceId, actorId: ctx.userId });
    return { text: await llm.generate(prompt, { maxTokens: 1400 }), live: llm.isLive };
  },
};

/** The meeting agent reads the transcript and writes notes, decisions and action items. */
export async function summarizeMeeting(ctx: MeetCtx, id: string, deps: SummaryDeps = defaultSummaryDeps): Promise<MeetingView> {
  requireEditor(ctx);
  const { row } = await scoped(ctx, (tx) => meetingFor(tx, ctx, id));
  if (!row.transcript?.trim()) throw new HttpError(400, "Add the transcript first (upload the recording or paste it).");
  if ((row.summary as StoredSummary | null)?.applied) throw new HttpError(409, "The notes were already saved.");
  const out = await deps.generate(ctx, summaryPrompt(row.title, row.transcript));
  // Without a live model the provider's mock answers in prose: keep it as a
  // labelled mock summary (never saveable) instead of failing.
  const parsed = parseMeetingSummary(out.text) ?? (out.live ? null : { notes: out.text.trim().slice(0, 600) || "Mock summary.", decisions: [], actionItems: [] });
  if (!parsed) throw new HttpError(502, "The meeting agent's answer couldn't be read. Try again.");
  const stored: StoredSummary = { ...parsed, mock: !out.live, at: new Date().toISOString(), by: ctx.userId, applied: null };
  await scoped(ctx, (tx) => tx.meetingSession.update({ where: { id: row.id, workspaceId: ctx.workspaceId }, data: { summary: stored as unknown as Prisma.InputJsonValue } }));
  return getMeeting(ctx, id);
}

export interface ApplyInput {
  /** Per action item (by index): my reminder, a task in an ops project, or skip. */
  items: { index: number; target: "reminder" | "task" | "skip"; opsProjectId?: string | null }[];
  saveDoc: boolean;
}

export interface ApplyDeps {
  /** Writes the meeting's note (THE Notes server API: lib/notes/service createNote). */
  createNote: (input: CreateNoteInput) => Promise<{ id: string }>;
  timeZone: (userId: string) => Promise<string>;
}

export const defaultApplyDeps: ApplyDeps = {
  createNote: async (input) => ({ id: (await createNote(input)).id }),
  timeZone: async (userId) => {
    try {
      const { getUserPreferences } = await import("@/lib/preferences");
      return (await getUserPreferences(userId)).timeZone || "UTC";
    } catch {
      return "UTC";
    }
  },
};

/**
 * Save the meeting agent's record: the note (the Notes app — shared with the
 * workspace, or private to me when the call was in a private conversation;
 * provenance "meeting:<id>"; linked to the ops projects its tasks went to)
 * and the chosen action items as the person's reminders or as tasks in an
 * ops project (assigned to the member the item names, when there is exactly
 * one). Once per meeting; never from a mock summary.
 */
export async function applySummary(ctx: MeetCtx, id: string, input: ApplyInput, deps: ApplyDeps = defaultApplyDeps): Promise<MeetingView> {
  requireEditor(ctx);
  const { row, channel } = await scoped(ctx, (tx) => meetingFor(tx, ctx, id));
  const summary = row.summary as StoredSummary | null;
  if (!summary) throw new HttpError(400, "Summarize the meeting first.");
  if (summary.mock) throw new HttpError(409, "This is a mock summary (no model is configured), so nothing is saved from it.");
  if (summary.applied) throw new HttpError(409, "The notes were already saved.");
  const tz = await deps.timeZone(ctx.userId);
  const members = await workspaceMembers(ctx.workspaceId);
  const picks = input.items.filter((i) => i.target !== "skip" && Number.isInteger(i.index) && i.index >= 0 && i.index < summary.actionItems.length);
  if (new Set(picks.map((p) => p.index)).size !== picks.length) throw new HttpError(400, "Each action item can be saved once.");
  // Every ops project is checked before anything is written (no orphan note).
  const projectIds = [...new Set(picks.filter((p) => p.target === "task").map((p) => p.opsProjectId ?? ""))];
  if (projectIds.length) {
    const found = await scoped(ctx, (tx) => tx.opsProject.findMany({ where: { workspaceId: ctx.workspaceId, id: { in: projectIds.filter(Boolean) } }, select: { id: true } }));
    if (found.length !== projectIds.length) throw new HttpError(400, "Pick the ops project for that task.");
  }
  const docId = input.saveDoc
    ? (
        await deps.createNote({
          workspaceId: ctx.workspaceId,
          createdBy: ctx.userId,
          title: `Meeting notes: ${row.title}`.slice(0, 200),
          body: notesMarkdown({ title: row.title, when: row.startedAt.toISOString().slice(0, 16).replace("T", " ") + " UTC", summary, transcriptSource: row.transcriptSource }),
          // Meetings, calendar events and channels have no Spotlight record
          // kind, so the meeting is the note's provenance (sourceRef — the
          // Notes app links back to it) and the meeting keeps the note's id.
          // The ops projects the action items went to ARE records: linked.
          links: projectIds.map((pid) => ({ kind: "ops_project", id: pid })),
          shareState: channel?.private ? "private" : "workspace",
          sourceRef: `meeting:${row.id}`,
          actor: "user",
        })
      ).id
    : null;
  const reminders: string[] = [];
  const tasks: string[] = [];
  try {
    await scoped(ctx, async (tx) => {
      const { createReminder } = await import("../reminders");
      for (const p of picks) {
        const item = summary.actionItems[p.index]!;
        const dueAt = dueToUtc(item.due, tz);
        if (p.target === "reminder") {
          const r = await createReminder(tx, {
            workspaceId: ctx.workspaceId,
            userId: ctx.userId,
            title: item.title.slice(0, 200),
            notes: `From the meeting "${row.title}"${item.owner ? ` (owner: ${item.owner})` : ""}.`,
            dueAt,
            sourceRef: `meeting:${row.id}`,
          });
          reminders.push(r.id);
        } else {
          const project = p.opsProjectId ? await tx.opsProject.findFirst({ where: { id: p.opsProjectId, workspaceId: ctx.workspaceId }, select: { id: true } }) : null;
          if (!project) throw new HttpError(400, "Pick the ops project for that task.");
          const t = await tx.opsTask.create({
            data: {
              workspaceId: ctx.workspaceId,
              projectId: project.id,
              title: item.title.slice(0, 200),
              description: `From the meeting "${row.title}"${item.owner ? ` (owner: ${item.owner})` : ""}.`,
              assigneeId: matchOwner(item.owner, members),
              dueAt,
              createdBy: ctx.userId,
              sourceRef: `meeting:${row.id}`,
            },
            select: { id: true },
          });
          tasks.push(t.id);
        }
      }
      const applied = { at: new Date().toISOString(), by: ctx.userId, docId, reminders, tasks };
      // Once: only if nobody applied it meanwhile.
      const n = await tx.meetingSession.updateMany({
        where: { id: row.id, workspaceId: ctx.workspaceId, updatedAt: row.updatedAt },
        data: { summary: { ...summary, applied } as unknown as Prisma.InputJsonValue, notesDocId: docId },
      });
      if (n.count !== 1) throw new HttpError(409, "Someone saved these notes at the same time.");
    });
  } catch (err) {
    // Nothing half-saved: the items rolled back, so the note goes too.
    if (docId) await scoped(ctx, (tx) => tx.univerDoc.deleteMany({ where: { id: docId, workspaceId: ctx.workspaceId, kind: "note" } })).catch(() => undefined);
    throw err;
  }
  return getMeeting(ctx, id);
}

/** Ops projects for the "add as a task" choice. */
export async function opsProjects(ctx: MeetCtx): Promise<{ id: string; name: string }[]> {
  return scoped(ctx, (tx) => tx.opsProject.findMany({ where: { workspaceId: ctx.workspaceId }, select: { id: true, name: true }, orderBy: { updatedAt: "desc" }, take: 100 }));
}
