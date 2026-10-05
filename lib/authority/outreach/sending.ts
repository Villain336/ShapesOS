// ShapesOS — Phase 4b live outreach sending partners (Smartlead / Instantly).
//
// Neither provider exposes a "send this one email now" API: both send from
// provider-side campaigns. The live path therefore uses RELAY CAMPAIGNS —
// one provider campaign per sequence step (initial, follow-up 1, follow-up 2),
// each with a single email step whose subject/body are the merge fields
// {{shapes_subject}} / {{shapes_body}} (plus {{shapes_unsubscribe_url}} and
// {{shapes_physical_address}} for the CAN-SPAM footer). ShapesOS keeps
// every rail (approvals, depth-3 activation, caps, CASL, suppression,
// bounce circuit) in lib/authority/outreach/sequences.ts; the provider only
// delivers. Adding the lead to the step's relay campaign IS the send.
//
//   Smartlead: POST https://server.smartlead.ai/api/v1/campaigns/{id}/leads?api_key=…
//              { lead_list: [{ email, custom_fields }], settings: {…} }
//   Instantly: POST https://api.instantly.ai/api/v2/leads  (Bearer API key)
//              { campaign, email, custom_variables, skip_if_in_campaign: true }
//
// Idempotency: every send carries `shapes:<sequenceId>:<stepIndex>` in its
// custom fields, and both providers key leads by email within a campaign
// (Smartlead skips duplicates; Instantly skip_if_in_campaign). A retried
// send after a crash therefore never delivers twice; a duplicate answer is
// reported as accepted with the same message id.
// Webhooks (lib/authority/outreach/webhooks.ts) map events back through the
// shapes_sequence_id / shapes_workspace_id fields the relay echoes.
//
// Config (all optional; fake partner stays the default without them):
//   SMARTLEAD_API_KEY + SMARTLEAD_RELAY_CAMPAIGN_IDS="<step0>,<step1>,<step2>"
//   INSTANTLY_API_KEY + INSTANTLY_RELAY_CAMPAIGN_IDS="<uuid0>,<uuid1>,<uuid2>"

import { liveRequest, ConnectorApiError, type LiveDeps } from "@/lib/connectors/m21/live/http";
import type { SendingPartner, SendRequest, SendResult } from "@/lib/authority/fake";

export const SMARTLEAD_BASE = "https://server.smartlead.ai/api/v1";
export const INSTANTLY_BASE = "https://api.instantly.ai/api/v2";

export class SendRejectedError extends Error {
  readonly reason: string;
  constructor(provider: string, reason: string) {
    super(`${provider} did not accept the send: ${reason}`);
    this.name = "SendRejectedError";
    this.reason = reason;
  }
}

/** Parse "id0,id1,id2" → per-step relay campaign ids. */
export function parseRelayCampaignIds(raw: string | undefined | null): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9-]{1,64}$/.test(s));
}

export function idempotencyKeyFor(req: Pick<SendRequest, "sequenceId" | "stepIndex" | "idempotencyKey">): string {
  return req.idempotencyKey ?? `shapes:${req.sequenceId}:${req.stepIndex ?? 0}`;
}

function relayFor(provider: string, ids: string[], stepIndex: number | undefined): string {
  const id = ids[stepIndex ?? 0];
  if (!id) {
    throw new ConnectorApiError(
      provider,
      "config_missing",
      `${provider} has no relay campaign for step ${stepIndex ?? 0} — add it to the relay campaign id list.`,
    );
  }
  return id;
}

export function relayFields(req: SendRequest): Record<string, string> {
  return {
    shapes_subject: req.subject,
    shapes_body: req.body,
    shapes_unsubscribe_url: req.unsubscribeUrl,
    shapes_physical_address: req.physicalAddress,
    shapes_from_mailbox: req.fromMailbox,
    shapes_sequence_id: req.sequenceId,
    shapes_campaign_id: req.campaignId,
    shapes_workspace_id: req.workspaceId ?? "",
    shapes_idempotency_key: idempotencyKeyFor(req),
  };
}

const n = (v: unknown) => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

export function createSmartleadPartner(cfg: { apiKey: string; relayCampaignIds: string[] }, deps: LiveDeps = {}): SendingPartner {
  return {
    name: "smartlead",
    async send(req): Promise<SendResult> {
      const campaignId = relayFor("Smartlead", cfg.relayCampaignIds, req.stepIndex);
      const key = idempotencyKeyFor(req);
      const res = await liveRequest<Record<string, unknown>>(
        {
          provider: "Smartlead",
          method: "POST",
          url: `${SMARTLEAD_BASE}/campaigns/${encodeURIComponent(campaignId)}/leads`,
          query: { api_key: cfg.apiKey },
          json: {
            lead_list: [{ email: req.to, custom_fields: relayFields(req) }],
            settings: {
              // ShapesOS suppression is authoritative, but provider lists stay on too.
              ignore_global_block_list: false,
              ignore_unsubscribe_list: false,
              ignore_community_bounce_list: false,
              ignore_duplicate_leads_in_other_campaign: true,
            },
          },
        },
        deps,
      );
      const added = n(res.added_count ?? res.upload_count);
      const duplicate = n(res.already_added_to_campaign ?? res.duplicate_count);
      if (added > 0 || duplicate > 0) {
        return { messageId: `smartlead:${campaignId}:${key}`, accepted: true, queuedAt: new Date() };
      }
      const reason =
        n(res.unsubscribed_leads) > 0 || (Array.isArray(res.unsubscribed_leads) && res.unsubscribed_leads.length)
          ? "recipient is on the provider unsubscribe list"
          : n(res.block_list) > 0 || (Array.isArray(res.block_list) && res.block_list.length)
            ? "recipient is on the provider block list"
            : n(res.invalid_email_count) > 0
              ? "invalid email address"
              : "the lead was skipped";
      throw new SendRejectedError("Smartlead", reason);
    },
    async mailboxWarmupStatus() {
      // Warmup health is read in the provider UI; never fabricated here.
      return { daysWarmed: 0, health: "unknown" };
    },
  };
}

export function createInstantlyPartner(cfg: { apiKey: string; relayCampaignIds: string[] }, deps: LiveDeps = {}): SendingPartner {
  return {
    name: "instantly",
    async send(req): Promise<SendResult> {
      const campaignId = relayFor("Instantly", cfg.relayCampaignIds, req.stepIndex);
      const key = idempotencyKeyFor(req);
      const res = await liveRequest<Record<string, unknown> | null>(
        {
          provider: "Instantly",
          method: "POST",
          url: `${INSTANTLY_BASE}/leads`,
          json: {
            campaign: campaignId,
            email: req.to,
            custom_variables: relayFields(req),
            skip_if_in_campaign: true,
          },
          auth: { token: cfg.apiKey },
        },
        deps,
      );
      const status = n(res?.status);
      if (status === -1 || status === -2) {
        throw new SendRejectedError("Instantly", status === -1 ? "recipient bounced before" : "recipient unsubscribed");
      }
      // A skipped duplicate (same email already in the relay campaign) has no
      // new lead id — report it as the same idempotent send.
      const leadId = typeof res?.id === "string" ? res.id : null;
      return { messageId: leadId ? `instantly:${leadId}` : `instantly:${campaignId}:${key}`, accepted: true, queuedAt: new Date() };
    },
    async mailboxWarmupStatus() {
      return { daysWarmed: 0, health: "unknown" };
    },
  };
}
