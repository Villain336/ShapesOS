// ShapesOS — inbox formatting helpers (pure; shared by the queue sources on
// the server and the Agentic OS approval cards in the browser).

import type { InboxLine } from "./types";

export function clip(s: string | null | undefined, n = 140): string | null {
  if (!s) return null;
  const t = s.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** "outreach_send" → "Outreach send". */
export function humanize(s: string): string {
  const t = s.replace(/[_.:-]+/g, " ").replace(/\s+/g, " ").trim();
  return t ? t[0]!.toUpperCase() + t.slice(1).toLowerCase() : s;
}

export function money(cents: number | null | undefined): string | null {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return null;
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const MAX_LINES = 4;

/**
 * Scalar facts of a payload as approval-card rows ("Channel · email",
 * "Recipients · 14"), in key order; objects, arrays and empty values are
 * skipped, ids and hashes too (they mean nothing to the person deciding).
 */
export function factLines(record: unknown, max = MAX_LINES): { lines: InboxLine[]; total: number } {
  if (!record || typeof record !== "object" || Array.isArray(record)) return { lines: [], total: 0 };
  const all: InboxLine[] = [];
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    if (/(^|_)(id|ids|hash)$|Id$|Hash$/.test(key)) continue;
    let detail: string | null = null;
    if (typeof value === "string") detail = clip(value, 80);
    else if (typeof value === "number" && Number.isFinite(value)) {
      detail = /cents$/i.test(key) ? money(value) : value.toLocaleString("en-US");
    } else if (typeof value === "boolean") detail = value ? "Yes" : "No";
    if (!detail) continue;
    all.push({ label: humanize(key.replace(/Cents$/i, "").replace(/([a-z])([A-Z])/g, "$1 $2")), detail });
  }
  return { lines: all.slice(0, Math.max(0, max)), total: all.length };
}
