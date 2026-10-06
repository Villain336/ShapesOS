// ShapesOS — Phase 18.2 (WS=comms): wall-clock ↔ instant helpers for the
// comms apps' pickers (PURE, client-safe). A <input type="datetime-local">
// value ("2026-10-12T09:00") is a wall time in the MEMBER's time zone (their
// preference, else the browser's), not the server's.

import { resolveTimeZone, zonedParts, zonedTimeToUtc } from "@/lib/time/zoned";

/** The browser's zone (UTC on the server / when unknown). */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

/** "2026-10-12T09:00" in `tz` → ISO instant (null when malformed). */
export function wallToIso(wall: string, tz: string | null | undefined): string | null {
  const m = WALL_RE.exec(wall.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const zone = resolveTimeZone(tz ?? deviceTimeZone());
  return zonedTimeToUtc(Number(y), Number(mo), Number(d), Number(h) * 60 + Number(mi), zone).date.toISOString();
}

/** ISO instant → "2026-10-12T09:00" wall time in `tz` (for a datetime-local value). */
export function isoToWall(iso: string | Date, tz: string | null | undefined): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "";
  const p = zonedParts(d, resolveTimeZone(tz ?? deviceTimeZone()));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** "YYYY-MM-DD" of an instant in `tz`. */
export function localDay(d: Date | string, tz: string | null | undefined): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return zonedParts(date, resolveTimeZone(tz ?? deviceTimeZone())).ymd;
}

/** Overdue / today / later / none — the Reminders app's groups. */
export function dueGroup(dueAt: string | null, now: Date, tz: string | null | undefined): "overdue" | "today" | "later" | "none" {
  if (!dueAt) return "none";
  const due = new Date(dueAt);
  if (due.getTime() < now.getTime()) return "overdue";
  return localDay(due, tz) === localDay(now, tz) ? "today" : "later";
}
