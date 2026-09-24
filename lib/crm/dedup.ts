// Marketr — Lead Pipeline CRM: dedup identity + scoring persistence.
//
// dedupKeyFor() normalizes the identity so the same human submitted twice
// (web form, then CSV import) collapses to one lead. The UNIQUE
// (workspaceId, dedupKey) constraint is the race-safe backstop: concurrent
// creates with the same key serialize on the row and the loser gets P2002,
// which the API translates into a 409 duplicate response.

import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { scoreFor, scoreBand, type ScoreBand } from "./stages";

/** "email:<lowercased-trimmed>" | "phone:<digits>" | null (no identity). */
export function dedupKeyFor(email?: string | null, phone?: string | null): string | null {
  const e = (email ?? "").trim().toLowerCase();
  if (e) return `email:${e}`;
  const digits = (phone ?? "").replace(/\D+/g, "");
  // Require a plausible phone length so "0" / "123" don't all collide.
  if (digits.length >= 7) return `phone:${digits}`;
  return null;
}

/** Recompute and persist a lead's score; logs score_change only on band cross. */
export async function recomputeScore(leadId: string, workspaceId: string, now = new Date()) {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, workspaceId },
    include: { activities: { select: { type: true } } },
  });
  if (!lead) return null;
  const engagement = lead.activities.filter((a) =>
    ["note", "email", "call", "sms", "meeting", "form_submit"].includes(a.type),
  ).length;
  const { score, band, reasons } = scoreFor({
    source: lead.source,
    email: lead.email,
    phone: lead.phone,
    company: lead.company,
    lastActivityAt: lead.lastActivityAt,
    engagementCount: engagement,
    now,
  });
  const prevBand: ScoreBand = scoreBand(lead.score);
  await prisma.lead.update({ where: { id: lead.id }, data: { score } });
  if (band !== prevBand) {
    await prisma.leadActivity.create({
      data: {
        workspaceId,
        leadId: lead.id,
        type: "score_change",
        body: `Score ${lead.score} → ${score} (${prevBand} → ${band}): ${reasons.join("; ")}`,
        actor: "System",
      },
    });
  }
  return { score, band, reasons };
}

/** Append an activity and touch lastActivityAt (drives recency scoring). */
export async function logActivity(opts: {
  workspaceId: string;
  leadId: string;
  type: "created" | "note" | "email" | "call" | "sms" | "meeting" | "stage_change" | "score_change" | "form_submit" | "import";
  body?: string;
  actor?: string;
}) {
  const [activity] = await prisma.$transaction([
    prisma.leadActivity.create({ data: opts }),
    prisma.lead.update({
      where: { id: opts.leadId },
      data: { lastActivityAt: new Date() },
    }),
  ]);
  return activity;
}

/** sha256 hex of a capture-form token (token itself is never stored). */
export function hashFormToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Public token format: mkfrm_<32 hex>. Prefix stored for admin display. */
export function newFormToken(): { token: string; prefix: string } {
  const token = `mkfrm_${randomBytes(16).toString("hex")}`;
  return { token, prefix: token.slice(0, 12) + "…" };
}
