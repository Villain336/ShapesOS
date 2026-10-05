// ShapesOS — Phase 12 (people): event reminders through the EXISTING nurture
// sequences (lib/messaging/sequences.ts) — no second messaging engine.
//
// When an event names a reminder sequence, each CONFIRMED registration's
// registrant is enrolled into it once: the CRM lead with the same email is
// reused (dedup key), or created in the workspace's default pipeline
// (lib/crm/leads.ts createLeadRecord — the same capture path as forms).
// Every step the sequence then sends goes through the nurture engine's
// approval queue and the messaging dispatcher (consent, quiet hours, caps),
// exactly like any other nurture send. Runs after the registration's
// transaction commits; best-effort and idempotent (remindersEnrolledAt is
// claimed with a guarded update).

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { createLeadRecord } from "@/lib/crm/leads";
import { dedupKeyFor } from "@/lib/crm/dedup";
import { enrollLead } from "@/lib/messaging/sequences";

export interface ReminderOutcome {
  enrolled: boolean;
  reason?: string;
  leadId?: string;
}

async function audit(workspaceId: string, registrationId: string, action: string, summary: string) {
  await withWorkspaceScope(workspaceId, (tx) =>
    tx.opsAuditEvent.create({ data: { workspaceId, entity: "event-registrations", entityId: registrationId, action, actor: "event-reminders", summary: summary.slice(0, 2000) } }),
  );
}

/** Find the lead for this email, or create it in the default pipeline. */
export async function leadForRegistrant(workspaceId: string, name: string, email: string, eventTitle: string): Promise<string | null> {
  const dedupKey = dedupKeyFor(email);
  if (dedupKey) {
    const existing = await prisma.lead.findFirst({ where: { workspaceId, dedupKey }, orderBy: { createdAt: "desc" }, select: { id: true } });
    if (existing) return existing.id;
  }
  const pipeline = await prisma.pipeline.findFirst({ where: { workspaceId }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }], select: { id: true } });
  if (!pipeline) return null;
  const r = await createLeadRecord(workspaceId, "event-registration", {
    pipelineId: pipeline.id,
    name,
    email,
    source: "other",
    sourceDetail: `Event registration: ${eventTitle}`.slice(0, 200),
  });
  if (r.ok) return r.lead.id;
  return r.existing?.id ?? null;
}

export async function enrollRegistrationReminders(workspaceId: string, registrationId: string): Promise<ReminderOutcome> {
  const reg = await withWorkspaceScope(workspaceId, (tx) =>
    tx.opsEventRegistration.findFirst({
      where: { id: registrationId, workspaceId },
      select: { status: true, name: true, email: true, remindersEnrolledAt: true, event: { select: { title: true, reminderSequenceId: true } } },
    }),
  );
  if (!reg) return { enrolled: false, reason: "registration not found" };
  if (reg.status !== "confirmed") return { enrolled: false, reason: `registration is ${reg.status}` };
  if (reg.remindersEnrolledAt) return { enrolled: false, reason: "already enrolled" };
  const sequenceId = reg.event.reminderSequenceId;
  if (!sequenceId) return { enrolled: false, reason: "the event has no reminder sequence" };

  const leadId = await leadForRegistrant(workspaceId, reg.name, reg.email, reg.event.title);
  if (!leadId) {
    await audit(workspaceId, registrationId, "reminders_skipped", "reminders not enrolled: the workspace has no CRM pipeline to hold the registrant's lead");
    return { enrolled: false, reason: "no CRM pipeline" };
  }
  // Claim first so two confirmations can't both enroll; roll it back if
  // the enrollment itself fails.
  const claimed = await withWorkspaceScope(workspaceId, (tx) =>
    tx.opsEventRegistration.updateMany({ where: { id: registrationId, workspaceId, remindersEnrolledAt: null }, data: { remindersEnrolledAt: new Date() } }),
  );
  if (claimed.count !== 1) return { enrolled: false, reason: "already enrolled" };
  try {
    const r = await enrollLead(workspaceId, sequenceId, leadId);
    await audit(workspaceId, registrationId, "reminders_enrolled", `registrant enrolled in reminder sequence ${sequenceId} (lead ${leadId}${r.alreadyEnrolled ? ", already active" : ""})`);
    return { enrolled: true, leadId };
  } catch (err) {
    await withWorkspaceScope(workspaceId, (tx) => tx.opsEventRegistration.updateMany({ where: { id: registrationId, workspaceId }, data: { remindersEnrolledAt: null } }));
    await audit(workspaceId, registrationId, "reminders_failed", `reminder enrollment failed: ${(err as Error)?.message ?? "error"}`);
    return { enrolled: false, reason: (err as Error)?.message ?? "enroll failed" };
  }
}

/** Catch-up: enroll every confirmed registration of an event that isn't yet. */
export async function enrollEventReminders(workspaceId: string, eventId: string): Promise<{ enrolled: number; skipped: number }> {
  const ids = await withWorkspaceScope(workspaceId, (tx) =>
    tx.opsEventRegistration.findMany({ where: { workspaceId, eventId, status: "confirmed", remindersEnrolledAt: null }, select: { id: true }, take: 500 }),
  );
  let enrolled = 0;
  let skipped = 0;
  for (const { id } of ids) {
    const r = await enrollRegistrationReminders(workspaceId, id);
    if (r.enrolled) enrolled += 1;
    else skipped += 1;
  }
  return { enrolled, skipped };
}
