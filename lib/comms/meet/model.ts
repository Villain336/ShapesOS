// ShapesOS — Phase 18.2 (WS=comms): Meet — the pure rules.
//
//   origins     where a meeting starts: ad hoc, a calendar event, a channel
//   rooms       one LiveKit room per meeting, tenant-scoped name
//   transcript  post-call only (an uploaded recording, or pasted text) —
//               nothing records during the call; trimmed head + tail for the
//               model
//   summary     the meeting agent's JSON: notes, decisions, action items
//               ({ title, owner, due }) — parsed defensively, never invented
//   recordings  the seam for Zoom / Google Meet recordings (Phase 18.5):
//               listed, not available yet

import { zonedTimeToUtc } from "@/lib/time/zoned";

export const MEETING_ORIGINS = ["adhoc", "calendar", "channel"] as const;
export type MeetingOrigin = (typeof MEETING_ORIGINS)[number];

export function isMeetingOrigin(v: unknown): v is MeetingOrigin {
  return typeof v === "string" && (MEETING_ORIGINS as readonly string[]).includes(v);
}

/** A calendar origin ref: the Calendar app's event id ("<source>:<id…>"). */
export function validCalendarRef(ref: string | null | undefined): boolean {
  return !!ref && /^(google|outlook|booking|ops_event|focus|meeting|social|reminder):[^\s]{1,300}$/.test(ref);
}

export function meetingRoomName(workspaceId: string, meetingId: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
  return `meet-${clean(workspaceId)}-${clean(meetingId)}`;
}

export const MAX_TRANSCRIPT_CHARS = 200_000;
export const MAX_RECORDING_BYTES = 25 * 1024 * 1024; // the Whisper API's own limit

/** The transcript the model reads: all of it when short, else the head and the tail. */
export function trimTranscript(text: string, max = 24_000): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const half = Math.floor((max - 40) / 2);
  return `${t.slice(0, half)}\n\n[… ${t.length - 2 * half} characters left out …]\n\n${t.slice(-half)}`;
}

export interface ActionItem {
  title: string;
  owner: string | null;
  /** YYYY-MM-DD (the meeting's own words, never guessed). */
  due: string | null;
}

export interface MeetingSummary {
  notes: string;
  decisions: string[];
  actionItems: ActionItem[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date "YYYY-MM-DD" (2026-02-30 is not). */
function realDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

/** The meeting agent's answer → a summary (tolerates fences and prose; null when unusable). PURE. */
export function parseMeetingSummary(raw: string): MeetingSummary | null {
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const notes = str(j.notes, 6000);
  const decisions = Array.isArray(j.decisions) ? j.decisions.map((d) => str(d, 500)).filter((d): d is string => !!d).slice(0, 30) : [];
  const items: ActionItem[] = [];
  for (const a of Array.isArray(j.actionItems) ? j.actionItems : Array.isArray(j.action_items) ? j.action_items : []) {
    const o = (typeof a === "string" ? { title: a } : a) as Record<string, unknown>;
    const title = str(o?.title, 300);
    if (!title) continue;
    const due = str(o.due, 10);
    items.push({ title, owner: str(o.owner, 120), due: due && realDate(due) ? due : null });
    if (items.length >= 30) break;
  }
  if (!notes && !decisions.length && !items.length) return null;
  return { notes: notes ?? "", decisions, actionItems: items };
}

/** "2026-10-09" → that day at 09:00 in the person's zone (a reminder's due time). */
export function dueToUtc(due: string | null, timeZone: string): Date | null {
  if (!due || !realDate(due)) return null;
  const [y, mo, d] = due.split("-").map(Number) as [number, number, number];
  return zonedTimeToUtc(y, mo, d, 9 * 60, timeZone).date;
}

/** Match an action item's owner to a workspace member (full name, first name if unique, email). PURE. */
export function matchOwner(owner: string | null, members: readonly { userId: string; name: string | null; email: string | null }[]): string | null {
  if (!owner) return null;
  const o = owner.trim().toLowerCase();
  const byFull = members.filter((m) => (m.name ?? "").trim().toLowerCase() === o || (m.email ?? "").toLowerCase() === o);
  if (byFull.length === 1) return byFull[0]!.userId;
  const byFirst = members.filter((m) => (m.name ?? "").trim().toLowerCase().split(/\s+/)[0] === o);
  return byFirst.length === 1 ? byFirst[0]!.userId : null;
}

/** The meeting agent's prompt. PURE. */
export function summaryPrompt(title: string, transcript: string): string {
  return [
    "You are the meeting agent. Read the transcript and write the record of the meeting. Use ONLY what the transcript says; never invent names, dates, numbers or decisions.",
    'Respond with ONLY a JSON object: {"notes": "5-10 plain sentences: what was discussed", "decisions": ["each decision made"], "actionItems": [{"title": "what to do, as a short imperative", "owner": "the person named, or null", "due": "YYYY-MM-DD only if a date was said, else null"}]}.',
    "Empty lists are fine when there were no decisions or action items.",
    "",
    `Meeting: ${title}`,
    "Transcript:",
    trimTranscript(transcript),
  ].join("\n");
}

/** Doc paragraphs for the notes doc (Univer). PURE. */
export function notesParagraphs(input: { title: string; when: string; summary: MeetingSummary; transcriptSource: string }): { text: string; headingLevel?: 0 | 1 | 2 | 3 }[] {
  const out: { text: string; headingLevel?: 0 | 1 | 2 | 3 }[] = [{ text: input.when }, { text: "" }, { text: "Notes", headingLevel: 2 }];
  for (const p of input.summary.notes.split(/\n{2,}/)) if (p.trim()) out.push({ text: p.trim() });
  out.push({ text: "Decisions", headingLevel: 2 });
  if (input.summary.decisions.length) for (const d of input.summary.decisions) out.push({ text: `• ${d}` });
  else out.push({ text: "None recorded." });
  out.push({ text: "Action items", headingLevel: 2 });
  if (input.summary.actionItems.length)
    for (const a of input.summary.actionItems) out.push({ text: `• ${a.title}${a.owner ? ` — ${a.owner}` : ""}${a.due ? ` (due ${a.due})` : ""}` });
  else out.push({ text: "None recorded." });
  out.push({ text: "" }, { text: `Written by the meeting agent from the ${input.transcriptSource} transcript (after the call).` });
  return out;
}

/**
 * Where a transcript can come from. Recording imports from Zoom and Google
 * Meet are a seam for Phase 18.5: listed so the product can say so, never
 * faked. Upload (a recording file, transcribed by Whisper) and paste work now.
 */
export const RECORDING_SOURCES = [
  { key: "upload", available: true },
  { key: "paste", available: true },
  { key: "zoom", available: false, phase: "18.5" },
  { key: "google_meet", available: false, phase: "18.5" },
] as const;
export type RecordingSourceKey = (typeof RECORDING_SOURCES)[number]["key"];

export interface RecordingImporter {
  key: Extract<RecordingSourceKey, "zoom" | "google_meet">;
  /** Fetch a finished meeting's recording audio (18.5 implements these with the connectors). */
  fetchRecording(input: { workspaceId: string; userId: string; externalMeetingId: string }): Promise<{ audio: Buffer; mimeType: string; fileName: string }>;
}

/** Registered importers (none until 18.5). */
export const RECORDING_IMPORTERS: Partial<Record<RecordingImporter["key"], RecordingImporter>> = {};
