// Marketr — POST /api/authority/intelligence/connect
// Stack OAuth/vault connection for the Intelligence Report.
//
// Body: { connector: ConnectorKey, mode?: "fixture" | "api_key",
//         apiKey?: string, label?: string }
// Fixture mode is the default: installs a labeled fixture connection so the
// report compiles on day one without live credentials. API-key mode stores
// the key via the encrypted vault (never echoed back).

import type { NextRequest } from "next/server";
import { z } from "zod";
import { authorityGuard, badRequest, safetyError, readJson } from "@/app/api/authority/_lib";
import { CONNECTOR_DEFS, installFixture, disconnectConnector } from "@/lib/authority/intelligence/connectors";
import { storeApiKey, deleteConnection } from "@/lib/vault/apikey";
import { authorityAudit } from "@/lib/authority/db";

export const dynamic = "force-dynamic";

const schema = z.object({
  connector: z.enum(["website", "gbp", "ga4", "search-console", "meta", "google-ads", "crm", "email", "shopify", "social"]),
  mode: z.enum(["fixture", "api_key"]).default("fixture"),
  apiKey: z.string().optional(),
  label: z.string().max(120).optional(),
  disconnect: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  const gate = await authorityGuard("editor");
  if (gate instanceof Response) return gate;
  const parsed = schema.safeParse(await readJson(req));
  if (!parsed.success) return badRequest("Invalid connect payload.", parsed.error.issues);
  const { connector, mode, apiKey, label, disconnect } = parsed.data;

  try {
    const def = CONNECTOR_DEFS.find((d) => d.key === connector)!;
    if (disconnect) {
      await disconnectConnector(gate.workspaceId, connector);
      await deleteConnection(gate.workspaceId, def.vaultKey).catch(() => null);
      await authorityAudit.logAsync({
        workspaceId: gate.workspaceId, actor: gate.userId,
        action: "intelligence_connector_disconnected",
        entityType: "intelligence_connector", entityId: connector,
        detail: { connector },
      });
      return Response.json({ ok: true, connector, status: "disconnected" });
    }

    if (mode === "api_key") {
      if (!apiKey?.trim()) return badRequest("API key required for api_key mode.");
      await storeApiKey(gate.userId, gate.workspaceId, def.vaultKey, label ?? def.label, apiKey, {
        extra: { source: "intelligence-connect" },
      });
    } else {
      await installFixture(gate.workspaceId, gate.userId, connector, label);
    }

    await authorityAudit.logAsync({
      workspaceId: gate.workspaceId, actor: gate.userId,
      action: "intelligence_connector_connected",
      entityType: "intelligence_connector", entityId: connector,
      detail: { connector, mode },
    });
    return Response.json({ ok: true, connector, mode, status: mode === "fixture" ? "fixture" : "connected" });
  } catch (err) {
    return safetyError(err);
  }
}
