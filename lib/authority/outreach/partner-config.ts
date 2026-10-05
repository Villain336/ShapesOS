// ShapesOS — Phase 15.1: Smartlead / Instantly are BYOK, per workspace.
//
// Cold email goes out from the CUSTOMER's sending domains and reputation, so
// the key is the workspace's own, stored in the vault (Settings → Providers,
// lib/providers/workspace-credentials.ts "outreach:smartlead" /
// "outreach:instantly"). The host env keys (SMARTLEAD_API_KEY /
// INSTANTLY_API_KEY + *_RELAY_CAMPAIGN_IDS) are the SELF-HOSTED fallback only:
// on DEPLOYMENT_MODE=hosted they are never used for any workspace.
// Without a key the fake partner applies where fakes are allowed, else an
// honest NotConfiguredError (lib/authority/fake.ts resolveSendingPartner).

import { deploymentMode, type DeploymentMode } from "@/lib/billing/trial";

export type OutreachProvider = "smartlead" | "instantly";

export interface OutreachAccount {
  apiKey: string;
  relayCampaignIds: string;
}

export interface OutreachPartnerConfig {
  provider: OutreachProvider;
  apiKey: string | null;
  relayCampaignIds: string | null;
  /** Where the key came from: the workspace's vault, host env, or none. */
  source: "workspace" | "env" | "none";
}

type EnvLike = Record<string, string | undefined>;

const ENV_KEYS: Record<OutreachProvider, { key: string; relay: string }> = {
  smartlead: { key: "SMARTLEAD_API_KEY", relay: "SMARTLEAD_RELAY_CAMPAIGN_IDS" },
  instantly: { key: "INSTANTLY_API_KEY", relay: "INSTANTLY_RELAY_CAMPAIGN_IDS" },
};

function preferred(env: EnvLike): OutreachProvider | null {
  const p = (env.OUTREACH_SENDING_PROVIDER ?? "").trim().toLowerCase();
  return p === "smartlead" || p === "instantly" ? p : null;
}

/**
 * Pure: which sending account a workspace uses. The workspace's own account
 * wins (OUTREACH_SENDING_PROVIDER breaks a tie when it has both); env only
 * when self-hosted.
 */
export function outreachPartnerConfig(args: {
  workspace: Partial<Record<OutreachProvider, OutreachAccount>>;
  env?: EnvLike;
  mode?: DeploymentMode;
}): OutreachPartnerConfig {
  const env = args.env ?? process.env;
  const mode = args.mode ?? deploymentMode(env as NodeJS.ProcessEnv);
  const pref = preferred(env);
  const own = (["smartlead", "instantly"] as const).filter((p) => args.workspace[p]?.apiKey);
  if (own.length) {
    const provider = pref && own.includes(pref) ? pref : own[0];
    const acct = args.workspace[provider]!;
    return { provider, apiKey: acct.apiKey, relayCampaignIds: acct.relayCampaignIds || null, source: "workspace" };
  }
  if (mode !== "hosted") {
    const withKey = (["smartlead", "instantly"] as const).filter((p) => (env[ENV_KEYS[p].key] ?? "").trim());
    if (withKey.length) {
      const provider = pref && withKey.includes(pref) ? pref : withKey[0];
      return {
        provider,
        apiKey: (env[ENV_KEYS[provider].key] ?? "").trim(),
        relayCampaignIds: (env[ENV_KEYS[provider].relay] ?? "").trim() || null,
        source: "env",
      };
    }
  }
  return { provider: pref ?? "smartlead", apiKey: null, relayCampaignIds: null, source: "none" };
}

/** Load the workspace's own accounts from the vault (server only). */
export async function loadOutreachAccounts(workspaceId: string): Promise<Partial<Record<OutreachProvider, OutreachAccount>>> {
  const { loadWorkspaceCredentials } = await import("@/lib/vault/workspace-credential");
  const { credentialDef } = await import("@/lib/providers/workspace-credentials");
  const keys = { smartlead: credentialDef("outreach:smartlead")!.connectorKey, instantly: credentialDef("outreach:instantly")!.connectorKey };
  const payloads = await loadWorkspaceCredentials(workspaceId, Object.values(keys));
  const out: Partial<Record<OutreachProvider, OutreachAccount>> = {};
  for (const p of ["smartlead", "instantly"] as const) {
    const v = payloads[keys[p]];
    if (v && typeof v.apiKey === "string" && v.apiKey.trim()) {
      out[p] = { apiKey: v.apiKey.trim(), relayCampaignIds: typeof v.relayCampaignIds === "string" ? v.relayCampaignIds : "" };
    }
  }
  return out;
}
