// ShapesOS — Phase 18.1 (WS=desk): the "Today" briefing, pure half.
//
// Each morning the lead agent writes every opted-in member a short briefing
// from their calendar, what needs them, what ran overnight and the key
// numbers. It is written ONCE per member per local day on the background
// workload (the Message Batches path when available — lib/llm/batch.ts),
// stored in desktop_briefings, and only ever read on page load.
// This file: the local day, when it is due, the prompt, and cleaning the
// model's text. The server half is lib/desktop/briefing.server.ts.

import { DEFAULT_TIME_ZONE, resolveTimeZone, zonedParts } from "@/lib/time/zoned";

/** Local hour from which today's briefing is written. */
export const BRIEFING_HOUR = 6;
export const BRIEFING_MAX_TOKENS = 700;
export const BRIEFING_MAX_CHARS = 2400;
export const BRIEFING_BATCH_PURPOSE = "desktop_briefing";

export type BriefingStatus = "pending" | "ready" | "failed";

/** The member's local calendar day, YYYY-MM-DD. */
export function localDay(now: Date, timeZone: string | null | undefined): string {
  const p = zonedParts(now, resolveTimeZone(timeZone ?? DEFAULT_TIME_ZONE));
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Is it morning (or later) where the member is? */
export function isBriefingDue(now: Date, timeZone: string | null | undefined): boolean {
  const p = zonedParts(now, resolveTimeZone(timeZone ?? DEFAULT_TIME_ZONE));
  return Math.floor(p.minutes / 60) >= BRIEFING_HOUR;
}

export function batchKeyFor(day: string, userId: string): string {
  return `${BRIEFING_BATCH_PURPOSE}:${day}:${userId}`;
}

export interface BriefingInput {
  memberName: string | null;
  workspaceName: string;
  day: string;
  timeZone: string;
  calendar: { time: string; title: string }[];
  calendarConnected: boolean;
  needsYou: { count: number; items: string[] };
  overnight: { finished: number; failed: number; waiting: number; running: number; highlights: string[] };
  metrics: { label: string; value: string }[];
}

/** What the briefing was written from (counts only — stored with it, shown as provenance). */
export function briefingSources(input: BriefingInput): Record<string, number | boolean> {
  return {
    calendarEvents: input.calendar.length,
    calendarConnected: input.calendarConnected,
    needsYou: input.needsYou.count,
    overnightFinished: input.overnight.finished,
    overnightFailed: input.overnight.failed,
    metrics: input.metrics.length,
  };
}

function lines(items: string[], empty: string): string {
  return items.length ? items.map((i) => `- ${i}`).join("\n") : empty;
}

/**
 * The lead agent's instructions and the facts. Facts are data: the model is
 * told to use only them (no invented meetings or numbers) and to keep the
 * Agentic OS voice (sentence case, plain words, no hype).
 */
export function buildBriefingPrompt(input: BriefingInput): string {
  const who = input.memberName?.trim() ? input.memberName.trim().split(/\s+/)[0] : null;
  return [
    "You are the lead agent of a ShapesOS workspace. Write this member's morning briefing for today.",
    "",
    "Rules:",
    "- Use ONLY the facts below. Never invent meetings, people, numbers or results. If a section is empty, say so in a few words or skip it.",
    "- At most 6 short lines. Start with one sentence that says what matters most today, then '- ' bullets.",
    "- Plain, calm, specific. Sentence case. No greetings beyond the first name, no emojis, no hype, no headings.",
    "- Put anything waiting on the member first. Times are in the member's time zone.",
    "",
    `Member: ${who ?? "(name unknown)"}`,
    `Workspace: ${input.workspaceName}`,
    `Day: ${input.day} (${input.timeZone})`,
    "",
    `Calendar today${input.calendarConnected ? "" : " (no calendar connected; bookings only)"}:`,
    lines(input.calendar.map((c) => `${c.time} ${c.title}`), "- nothing scheduled"),
    "",
    `Waiting on the member (Needs you): ${input.needsYou.count}`,
    lines(input.needsYou.items, "- nothing waiting"),
    "",
    `Agent work since yesterday evening: ${input.overnight.finished} finished, ${input.overnight.failed} failed, ${input.overnight.waiting} waiting for an OK, ${input.overnight.running} still running`,
    lines(input.overnight.highlights, "- no notable runs"),
    "",
    "Key numbers:",
    lines(input.metrics.map((m) => `${m.label}: ${m.value}`), "- none available"),
  ].join("\n");
}

/** The model's text, made safe to store and show: trimmed, no headings or fences, capped. */
export function cleanBriefingText(raw: string): string {
  const out = raw
    .replace(/\r\n/g, "\n")
    .replace(/^```[a-z]*\n?|```$/gim, "")
    .split("\n")
    .map((l) => l.replace(/^#{1,6}\s+/, "").replace(/^\s*[*•]\s+/, "- ").trimEnd())
    .filter((l, i, a) => !(l.trim() === "" && (i === 0 || a[i - 1]!.trim() === "")))
    .join("\n")
    .trim();
  if (out.length <= BRIEFING_MAX_CHARS) return out;
  const cut = out.slice(0, BRIEFING_MAX_CHARS);
  return `${cut.slice(0, Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". ") + 1, 1)).trim()}`;
}

/** Split stored text into a lead sentence and bullets for display. */
export function briefingParts(text: string): { lead: string[]; bullets: string[] } {
  const lead: string[] = [];
  const bullets: string[] = [];
  for (const l of text.split("\n").map((x) => x.trim()).filter(Boolean)) {
    if (/^[-–]\s+/.test(l)) bullets.push(l.replace(/^[-–]\s+/, ""));
    else if (bullets.length === 0) lead.push(l);
    else bullets.push(l);
  }
  return { lead, bullets };
}
