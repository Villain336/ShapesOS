// ShapesOS — Phase 18.3 (WS=trust): the email digest and the agent-written
// summary, pure half (assembly + prompt). Server halves:
// lib/notifications/digest.server.ts and summary.server.ts.

import type { AlertPayload } from "@/lib/alerts/adapters";

/** Local hour from which the day's digest goes out. */
export const DIGEST_HOUR = 8;
/** Rows older than this are not mailed (they're stale; the bell still has them). */
export const DIGEST_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
export const DIGEST_MAX_ITEMS = 50;
/** desktop_briefings rows of the notification summary use this day prefix. */
export const SUMMARY_DAY_PREFIX = "notif-summary:";

export interface DigestItem {
  kind: string;
  title: string;
  body: string | null;
  href: string | null;
  createdAt: Date;
}

export interface DigestGroup {
  workspaceName: string;
  items: DigestItem[];
}

function absolute(href: string | null, appUrl: string | null): string | null {
  if (!href || !appUrl || !href.startsWith("/dashboard")) return null;
  return `${appUrl.replace(/\/$/, "")}${href}`;
}

/**
 * One email with everything unread, grouped by workspace, newest first, and
 * the lead agent's summary on top when the person opted in. PURE.
 */
export function assembleDigest(groups: readonly DigestGroup[], opts: { appUrl: string | null; summary?: string | null }): AlertPayload & { count: number } {
  const count = groups.reduce((n, g) => n + g.items.length, 0);
  const lines: string[] = [];
  if (opts.summary?.trim()) {
    lines.push("What happened (written by your lead agent):", opts.summary.trim(), "");
  }
  for (const g of groups) {
    if (!g.items.length) continue;
    lines.push(`${g.workspaceName} — ${g.items.length} unread`);
    for (const i of [...g.items].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, DIGEST_MAX_ITEMS)) {
      const link = absolute(i.href, opts.appUrl);
      lines.push(`• ${i.title}${i.body ? ` — ${i.body.replace(/\s+/g, " ").slice(0, 160)}` : ""}${link ? `\n  ${link}` : ""}`);
    }
    lines.push("");
  }
  lines.push("You get this email because the email digest is on in Settings → You → Notifications.");
  return {
    title: count === 1 ? "1 unread notification in ShapesOS" : `${count} unread notifications in ShapesOS`,
    body: lines.join("\n").trim(),
    links: opts.appUrl ? [{ label: "Open notifications", url: `${opts.appUrl.replace(/\/$/, "")}/dashboard/notifications` }] : [],
    count,
  };
}

export interface SummaryInput {
  memberName: string | null;
  workspaceName: string;
  day: string;
  language?: string | null;
  counts: Record<string, number>;
  items: string[];
}

const LANGUAGES: Record<string, string> = { en: "English", es: "Spanish (tú form)" };

/** The lead agent's prompt for the daily "what happened" summary. PURE. */
export function buildSummaryPrompt(input: SummaryInput): string {
  const who = input.memberName?.trim() ? input.memberName.trim().split(/\s+/)[0] : null;
  const counts = Object.entries(input.counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k.replace(/_/g, " ")}: ${n}`);
  return [
    "You are the lead agent of a ShapesOS workspace. Summarize what happened for this member in the last 24 hours, from their notifications.",
    "",
    "Rules:",
    "- Use ONLY the notifications below. Never invent events, people or numbers.",
    "- At most 5 short lines: one sentence on what matters most, then '- ' bullets. Anything still waiting on the member first.",
    "- Plain, calm, specific. Sentence case. No greeting beyond the first name, no emojis, no headings.",
    `- Write in ${LANGUAGES[input.language ?? "en"] ?? "English"}. Keep names and titles exactly as given.`,
    "",
    `Member: ${who ?? "(name unknown)"}`,
    `Workspace: ${input.workspaceName}`,
    `Day: ${input.day}`,
    "",
    `Counts: ${counts.length ? counts.join(", ") : "no notifications"}`,
    "Notifications (newest first):",
    input.items.length ? input.items.map((i) => `- ${i}`).join("\n") : "- none",
  ].join("\n");
}
