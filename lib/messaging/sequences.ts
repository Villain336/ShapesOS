// Marketr — R3 nurture sequence enrollment engine.
//
// Manual-approval only: every step send creates an ApprovalItem first and a
// queued OutboundMessage linked to it. NOTHING auto-sends — the messaging
// dispatcher only releases messages whose approval is "approved", and it
// also enforces consent / quiet hours / caps / dedup at dispatch time.
//
// `advanceEnrollments` is the cron tick (POST /api/cron/nurture): picks due
// enrollments, renders the next step, requests approval + queues the message,
// then advances currentStep/nextRunAt, completing the enrollment at the end.

import { prisma } from "@/lib/prisma";
import { queueMessage, requestApproval } from "./dispatcher";
import { leadTemplateValues, renderTemplate } from "./templates";

export type SequenceChannel = "sms" | "email" | "voice";

export interface NurtureStep {
  channel: SequenceChannel;
  delayMinutes: number;
  template: string;
  subject?: string;
}

const CHANNELS: SequenceChannel[] = ["sms", "email", "voice"];

export function parseSteps(raw: unknown): NurtureStep[] {
  if (!Array.isArray(raw)) return [];
  const steps: NurtureStep[] = [];
  for (const s of raw) {
    if (typeof s !== "object" || s === null) continue;
    const rec = s as Record<string, unknown>;
    const channel = rec.channel;
    const template = rec.template;
    if (!CHANNELS.includes(channel as SequenceChannel)) continue;
    if (typeof template !== "string" || !template.trim()) continue;
    steps.push({
      channel: channel as SequenceChannel,
      delayMinutes: Math.max(0, Math.floor(Number(rec.delayMinutes) || 0)),
      template,
      ...(typeof rec.subject === "string" && rec.subject ? { subject: rec.subject } : {}),
    });
  }
  return steps;
}

function publicOrigin(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

async function sequenceSendsToday(workspaceId: string, sequenceId: string): Promise<number> {
  // One "sequence_send" approval is requested per queued send, so counting
  // today's approvals for this sequence is the deterministic daily tally.
  return prisma.approvalItem.count({
    where: {
      workspaceId,
      kind: "sequence_send",
      createdAt: { gte: startOfToday() },
      payload: { path: ["sequenceId"], equals: sequenceId },
    },
  });
}

function renderBody(
  step: NurtureStep,
  lead: { name?: string | null; company?: string | null; email?: string | null; phone?: string | null },
  leadId: string,
): string {
  const values = {
    ...leadTemplateValues(lead),
    unsubscribeUrl: `${publicOrigin()}/api/nurture/unsubscribe?lead=${encodeURIComponent(leadId)}&channel=${step.channel}`,
  };
  // Email renders as HTML with lead data escaped; SMS/voice are plain text.
  return renderTemplate(step.template, values, { escape: step.channel === "email" });
}

export interface EnrollResult {
  enrollmentId: string;
  alreadyEnrolled: boolean;
  nextRunAt: Date | null;
}

/**
 * Enroll a lead into a sequence. Re-enrolling a completed/unenrolled/bounced
 * lead restarts it at step 0; re-enrolling an active lead is a no-op.
 */
export async function enrollLead(
  workspaceId: string,
  sequenceId: string,
  leadId: string,
): Promise<EnrollResult> {
  const sequence = await prisma.nurtureSequence.findFirst({
    where: { id: sequenceId, workspaceId },
    select: { id: true, status: true, steps: true },
  });
  if (!sequence) throw new Error("Sequence not found");
  if (sequence.status === "archived") throw new Error("Cannot enroll into an archived sequence");

  const lead = await prisma.lead.findFirst({
    where: { id: leadId, workspaceId },
    select: { id: true },
  });
  if (!lead) throw new Error("Lead not found");

  const existing = await prisma.sequenceEnrollment.findFirst({
    where: { sequenceId, leadId, workspaceId },
  });
  const steps = parseSteps(sequence.steps);
  const nextRunAt = new Date(Date.now() + (steps[0]?.delayMinutes ?? 0) * 60_000);

  if (existing) {
    if (existing.status === "active") {
      return { enrollmentId: existing.id, alreadyEnrolled: true, nextRunAt: existing.nextRunAt };
    }
    // Restart a terminal enrollment at step 0.
    const restarted = await prisma.sequenceEnrollment.update({
      where: { id: existing.id },
      data: { status: "active", currentStep: 0, nextRunAt, completedAt: null },
    });
    return { enrollmentId: restarted.id, alreadyEnrolled: false, nextRunAt };
  }

  const created = await prisma.sequenceEnrollment.create({
    data: { workspaceId, sequenceId, leadId, status: "active", currentStep: 0, nextRunAt },
  });
  return { enrollmentId: created.id, alreadyEnrolled: false, nextRunAt };
}

export interface AdvanceResult {
  processed: number;
  advanced: number;
  completed: number;
  skipped: number;
  errors: Array<{ enrollmentId: string; error: string }>;
}

/**
 * Advance every enrollment whose nextRunAt is due. Each advanced step queues
 * one approval-gated OutboundMessage (kind "sequence") and moves the
 * enrollment to the next step (or "completed" after the final step).
 * Enrollments on paused/draft sequences are left untouched (the sequence
 * owner resumes them); dailyCap is enforced per sequence per calendar day.
 */
export async function advanceEnrollments(workspaceId?: string): Promise<AdvanceResult> {
  const now = new Date();
  const enrollments = await prisma.sequenceEnrollment.findMany({
    where: {
      ...(workspaceId ? { workspaceId } : {}),
      status: "active",
      nextRunAt: { lte: now },
    },
    include: {
      sequence: { select: { id: true, workspaceId: true, name: true, status: true, steps: true, dailyCap: true } },
      lead: { select: { id: true, name: true, company: true, email: true, phone: true } },
    },
    take: 500,
    orderBy: { nextRunAt: "asc" },
  });

  const result: AdvanceResult = { processed: 0, advanced: 0, completed: 0, skipped: 0, errors: [] };

  for (const enr of enrollments) {
    result.processed += 1;
    try {
      const seq = enr.sequence;
      if (seq.status !== "active") {
        // Paused/draft sequences hold their enrollments until resumed.
        result.skipped += 1;
        continue;
      }
      const steps = parseSteps(seq.steps);
      if (enr.currentStep >= steps.length) {
        await prisma.sequenceEnrollment.update({
          where: { id: enr.id },
          data: { status: "completed", completedAt: now, nextRunAt: null },
        });
        result.completed += 1;
        continue;
      }

      if (seq.dailyCap != null) {
        const sentToday = await sequenceSendsToday(seq.workspaceId, seq.id);
        if (sentToday >= seq.dailyCap) {
          result.skipped += 1;
          continue;
        }
      }

      const step = steps[enr.currentStep];
      const body = renderBody(step, enr.lead, enr.leadId);
      // The dispatcher requires a subject for email — fall back to the
      // sequence name so an email step without one still queues.
      const subject = step.subject
        ? renderTemplate(step.subject, leadTemplateValues(enr.lead), { escape: false })
        : step.channel === "email"
          ? seq.name
          : undefined;

      // Manual approval FIRST — the message must not dispatch without it.
      const approval = await requestApproval({
        workspaceId: seq.workspaceId,
        kind: "sequence_send",
        payload: {
          sequenceId: seq.id,
          enrollmentId: enr.id,
          leadId: enr.leadId,
          channel: step.channel,
          stepIndex: enr.currentStep,
          subject: subject ?? null,
          body,
        },
        requestedBy: "nurture-engine",
      });

      await queueMessage({
        workspaceId: seq.workspaceId,
        leadId: enr.leadId,
        channel: step.channel,
        kind: "sequence",
        subject,
        body,
        approvalId: approval.id,
        requestedBy: "nurture-engine",
      });

      const nextStep = enr.currentStep + 1;
      if (nextStep >= steps.length) {
        await prisma.sequenceEnrollment.update({
          where: { id: enr.id },
          data: { status: "completed", completedAt: now, nextRunAt: null },
        });
        result.completed += 1;
      } else {
        await prisma.sequenceEnrollment.update({
          where: { id: enr.id },
          data: {
            currentStep: nextStep,
            nextRunAt: new Date(now.getTime() + steps[nextStep].delayMinutes * 60_000),
          },
        });
        result.advanced += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "advance failed";
      // Permanent channel failures (e.g. voice is not implemented in the R3
      // messaging core) must not poison the queue — bounce the enrollment so
      // it stops retrying and shows up in the enrollments tab.
      if (/voice channel is not implemented/i.test(message)) {
        await prisma.sequenceEnrollment.update({
          where: { id: enr.id },
          data: { status: "bounced", nextRunAt: null },
        });
      }
      result.errors.push({ enrollmentId: enr.id, error: message.slice(0, 200) });
    }
  }

  return result;
}
