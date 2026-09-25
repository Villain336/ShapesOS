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

/** Fake sending partner by default; real keys -> honest NotConfiguredError. */
export function sendingPartner() {
  return resolveSendingPartner({
    provider: (process.env.OUTREACH_SENDING_PROVIDER as "smartlead" | "instantly" | undefined) ?? "smartlead",
    apiKey: process.env.SMARTLEAD_API_KEY ?? process.env.INSTANTLY_API_KEY ?? null,
  });
}
