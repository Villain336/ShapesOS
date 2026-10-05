// Marketr — /api/authority/outreach shared stores (not a route: no HTTP exports).

import {
  prismaCampaignStore, prismaDomainStore, prismaProspectStore,
  prismaSequenceStore, prismaSuppressionStore,
} from "@/lib/authority/outreach";
import { resolveSendingPartner } from "@/lib/authority/fake";
import { loadOutreachAccounts, outreachPartnerConfig } from "@/lib/authority/outreach/partner-config";

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
 * Phase 15.1: the key is the WORKSPACE's own Smartlead / Instantly account
 * (vault, Settings → Providers); host env keys are the self-hosted fallback
 * only (lib/authority/outreach/partner-config.ts).
 */
export async function sendingPartner(workspaceId: string) {
  const cfg = outreachPartnerConfig({ workspace: await loadOutreachAccounts(workspaceId) });
  return resolveSendingPartner({
    provider: cfg.provider,
    apiKey: cfg.apiKey,
    relayCampaignIds: cfg.relayCampaignIds,
  });
}
