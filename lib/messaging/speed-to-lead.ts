// Marketr — R3 messaging core: speed-to-lead.
//
// triggerSpeedToLead(workspaceId, leadId): the moment a lead is created,
// fire the fastest consented channel — SMS first, then email. Consent-gated
// like everything else: no opt-in on either channel → a suppressed ledger
// row (reason "no_consent"), never a send.
//
// (Replaces the temporary stub the sequences agent carried while this
// module was being built; the signature is unchanged.)

import { prisma } from "@/lib/prisma";
import type { OutboundMessage } from "@prisma/client";
import { getConsent } from "./consent";
import { queueMessage } from "./dispatcher";
import { getMessagingSettings } from "./quiet-hours";

/**
 * Queue an immediate speed-to-lead touch on the fastest consented channel.
 * Exported for the sequences agent to call on lead creation.
 */
export async function triggerSpeedToLead(
  workspaceId: string,
  leadId: string,
): Promise<OutboundMessage> {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, workspaceId },
    select: { id: true, name: true, phone: true, email: true },
  });
  if (!lead) throw new Error("lead not found in workspace");

  const firstName = (lead.name ?? "").trim().split(/\s+/)[0] || "there";
  const settings = await getMessagingSettings(workspaceId);
  const biz = settings.businessName?.trim() ? ` from ${settings.businessName.trim()}` : "";

  const smsConsent = await getConsent(workspaceId, leadId, "sms");
  if (smsConsent === "opted_in" && lead.phone) {
    return queueMessage({
      workspaceId,
      leadId,
      channel: "sms",
      kind: "speed_to_lead",
      body: `Hi ${firstName}, thanks for reaching out${biz}! We'll be with you shortly. Reply STOP to opt out.`,
      requestedBy: "speed-to-lead",
    });
  }

  const emailConsent = await getConsent(workspaceId, leadId, "email");
  if (emailConsent === "opted_in" && lead.email) {
    return queueMessage({
      workspaceId,
      leadId,
      channel: "email",
      kind: "speed_to_lead",
      subject: "Thanks for reaching out",
      body:
        `Hi ${firstName},\n\nThanks for reaching out${biz}! We'll be in touch shortly.\n\n` +
        `If you need anything sooner, just reply to this email.`,
      requestedBy: "speed-to-lead",
    });
  }

  // No consented channel — log the suppression so the ledger shows the
  // lead was considered and deliberately not messaged.
  const provider = (process.env.MESSAGING_SMS_PROVIDER ?? "fake").trim().toLowerCase();
  return prisma.outboundMessage.create({
    data: {
      workspaceId,
      leadId,
      channel: lead.phone ? "sms" : "email",
      direction: "outbound",
      kind: "speed_to_lead",
      body: "(suppressed: no consented channel on file)",
      status: "suppressed",
      suppressionReason: "no_consent",
      provider,
      costCents: 0,
    },
  });
}
