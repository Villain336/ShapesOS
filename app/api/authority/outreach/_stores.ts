// Marketr — /api/authority/outreach shared stores (not a route: no HTTP exports).

import {
  prismaCampaignStore, prismaDomainStore, prismaProspectStore,
  prismaSequenceStore, prismaSuppressionStore,
} from "@/lib/authority/outreach";
import { resolveSendingPartner } from "@/lib/authority/fake";

export function outreachStores() {
  const campaigns = prismaCampaignStore();
  const domains = prismaDomainStore();
  const prospects = prismaProspectStore();
  const sequences = prismaSequenceStore();
  const suppression = prismaSuppressionStore();
  return { campaigns, domains, prospects, sequences, suppression };
}

/**
 * Fake sending partner by default. Phase 4b: with the provider's API key
 * AND its relay campaign ids the live adapter sends; a key without relay
 * ids is an honest NotConfiguredError.
 */
export function sendingPartner() {
  const provider =
    (process.env.OUTREACH_SENDING_PROVIDER as "smartlead" | "instantly" | undefined) ??
    (process.env.SMARTLEAD_API_KEY ? "smartlead" : process.env.INSTANTLY_API_KEY ? "instantly" : "smartlead");
  return resolveSendingPartner({
    provider,
    apiKey: provider === "instantly" ? (process.env.INSTANTLY_API_KEY ?? null) : (process.env.SMARTLEAD_API_KEY ?? null),
    relayCampaignIds:
      provider === "instantly" ? process.env.INSTANTLY_RELAY_CAMPAIGN_IDS : process.env.SMARTLEAD_RELAY_CAMPAIGN_IDS,
  });
}
