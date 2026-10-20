// ShapesOS — Phase 18.2 (WS=comms): iCalendar (RFC 5545) output — PURE.
//
// Used for the private subscribe feed (/api/comms/calendar/feed/<token>) and
// the ".ics" download of one event. Every instant is written in UTC
// ("…Z"), so no VTIMEZONE block is needed and every client shows the right
// local time; all-day events are DATE values. Text is escaped (\\ ; , and
// newlines) and lines are folded at 75 octets (UTF-8 safe), CRLF endings.

export interface IcsEvent {
  /** Stable, globally unique id (e.g. "booking-<id>@shapesos"). */
  uid: string;
  title: string;
  start: Date;
  end: Date | null;
  allDay?: boolean;
  description?: string | null;
  location?: string | null;
  url?: string | null;
  attendees?: string[];
  /** Last change (DTSTAMP / LAST-MODIFIED). */
  updatedAt?: Date | null;
  status?: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
}

export interface IcsCalendar {
  name: string;
  /** PRODID — identifies the producer. */
  prodId?: string;
  /** Suggested refresh for subscribers (minutes). */
  refreshMinutes?: number;
  events: IcsEvent[];
  now?: Date;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** 20261012T150000Z */
export function icsDateTime(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** 20261012 (a DATE value, the UTC calendar day). */
export function icsDate(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

/** TEXT escaping (RFC 5545 §3.3.11). */
export function escapeText(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

/** Fold one content line at 75 octets (continuation lines start with a space), never splitting a UTF-8 character. */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (curBytes + b > limit) {
      out.push(cur);
      cur = "";
      curBytes = 0;
      limit = 74; // continuation lines carry a leading space
    }
    cur += ch;
    curBytes += b;
  }
  if (cur) out.push(cur);
  return out.join("\r\n ");
}

function prop(name: string, value: string): string {
  return foldLine(`${name}:${value}`);
}

const SAFE_UID = /[^A-Za-z0-9@._-]/g;

export function eventLines(e: IcsEvent, now: Date): string[] {
  const lines = ["BEGIN:VEVENT", prop("UID", e.uid.replace(SAFE_UID, "-").slice(0, 200)), prop("DTSTAMP", icsDateTime(e.updatedAt ?? now))];
  if (e.allDay) {
    lines.push(prop("DTSTART;VALUE=DATE", icsDate(e.start)));
    const end = e.end && e.end.getTime() > e.start.getTime() ? e.end : new Date(e.start.getTime() + 86_400_000);
    lines.push(prop("DTEND;VALUE=DATE", icsDate(end)));
  } else {
    lines.push(prop("DTSTART", icsDateTime(e.start)));
    const end = e.end && e.end.getTime() > e.start.getTime() ? e.end : new Date(e.start.getTime() + 30 * 60_000);
    lines.push(prop("DTEND", icsDateTime(end)));
  }
  lines.push(prop("SUMMARY", escapeText(e.title || "(no title)")));
  if (e.description) lines.push(prop("DESCRIPTION", escapeText(e.description.slice(0, 4000))));
  if (e.location) lines.push(prop("LOCATION", escapeText(e.location)));
  if (e.url && /^https:\/\//.test(e.url)) lines.push(prop("URL", e.url));
  for (const a of (e.attendees ?? []).slice(0, 50)) {
    if (/^[^\s@<>"]+@[^\s@<>"]+$/.test(a)) lines.push(prop("ATTENDEE", `mailto:${a}`));
  }
  if (e.status) lines.push(prop("STATUS", e.status));
  if (e.updatedAt) lines.push(prop("LAST-MODIFIED", icsDateTime(e.updatedAt)));
  lines.push("END:VEVENT");
  return lines;
}

/** A whole VCALENDAR (CRLF line endings, ends with CRLF). */
export function buildIcs(cal: IcsCalendar): string {
  const now = cal.now ?? new Date();
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    prop("PRODID", cal.prodId ?? "-//ShapesOS//Calendar//EN"),
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    prop("X-WR-CALNAME", escapeText(cal.name)),
  ];
  if (cal.refreshMinutes) {
    lines.push(prop("REFRESH-INTERVAL;VALUE=DURATION", `PT${Math.max(15, Math.round(cal.refreshMinutes))}M`));
    lines.push(prop("X-PUBLISHED-TTL", `PT${Math.max(15, Math.round(cal.refreshMinutes))}M`));
  }
  for (const e of cal.events) lines.push(...eventLines(e, now));
  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

/** A safe .ics file name from an event title. */
export function icsFileName(title: string): string {
  const base = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .toLowerCase();
  return `${base || "event"}.ics`;
}
