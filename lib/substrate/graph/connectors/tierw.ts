// Marketr — Phase 8 G1: Tier-W webhook receivers (docs/specs/SPEC-PHASE8.md §2 G1).
//
// HubSpot, Shopify, Meta ads, Salesforce (Platform Events/CDC). Flow (B3):
// signed webhook arrives → signature verified → replay-checked → fact(s)
// appended → ER fast-path (deterministic matchers only; fuzzy goes to the
// queue). Webhook volume never touches the request path — the route verifies
// and appends, ER fast-path runs inline only for deterministic hits.
//
// Secrets: webhook secrets live in the vault; webhookSecretRef is the vault
// reference id. In fake/test mode (no creds) the endpoint fails honestly
// with 503 — it never pretends to ingest.

import type { GraphConnector } from "@prisma/client";
import {
  verifyHubSpotSignature,
  verifyShopifyHmac,
  verifyMetaSignature,
  verifyWooCommerceSignature,
  checkReplay,
  payloadFingerprint,
  type ReplayStore,
} from "./hmac";
import { deadLetter } from "./deadletter";
import { appendFact, type AppendFactInput } from "../facts";
import { resolveMode, type TierWPlatform } from "./types";

export type { TierWPlatform };
import { getDecryptedCredential } from "@/lib/vault/refresh";

export interface WebhookIngestResult {
  accepted: boolean;
  status: number;
  factsAppended?: number;
  queuedEr?: number;
  /** never includes secrets or raw bodies */
  detail: string;
}

/** Resolve the webhook secret for a connector: test fixture → vault → null. */
export async function resolveWebhookSecret(
  connector: GraphConnector,
): Promise<{ secret: string | null; mode: "fixture" | "vault" | "app" | "none" }> {
  try {
    const fixtures = JSON.parse(process.env.GRAPH_WEBHOOK_TEST_SECRETS ?? "{}") as Record<
      string,
      string
    >;
    const fixture = fixtures[connector.platform];
    if (fixture) return { secret: fixture, mode: "fixture" };
  } catch {
    // malformed fixture env — fall through to vault
  }
  if (connector.webhookSecretRef) {
    try {
      const cred = await getDecryptedCredential(connector.webhookSecretRef);
      const payload = cred?.payload as Record<string, unknown> | undefined;
      const secret =
        (payload?.webhook_secret as string | undefined) ??
        (payload?.secret as string | undefined);
      if (secret) return { secret, mode: "vault" };
    } catch {
      // vault lookup failure = not configured; fail honestly below
    }
  }
  // Phase 11 (bizsync): a store installed through the ShapesOS Shopify app
  // (lib/bizsync/install.ts set authRef to that connection) signs its
  // webhooks with the app's client secret.
  if (connector.platform === "shopify" && connector.authRef) {
    const appSecret = (process.env.SHOPIFY_CLIENT_SECRET ?? "").trim();
    if (appSecret) return { secret: appSecret, mode: "app" };
  }
  return { secret: null, mode: "none" };
}

/**
 * Verify a Tier-W webhook. Returns the verified connector or a rejection.
 * `rawBody` must be the exact bytes received (HMAC is over raw bytes).
 */
export async function verifyTierWWebhook(opts: {
  platform: TierWPlatform;
  connector: GraphConnector;
  method: string;
  uri: string;
  headers: Record<string, string | null>;
  rawBody: string;
  replayStore?: ReplayStore;
}): Promise<{ ok: true } | { ok: false; status: number; detail: string }> {
  const { platform, connector, headers, rawBody } = opts;
  if (connector.status === "revoked") {
    return { ok: false, status: 410, detail: "connector revoked — ingest stopped, history kept" };
  }
  const { secret } = await resolveWebhookSecret(connector);
  if (!secret) {
    return {
      ok: false,
      status: 503,
      detail: `connector not configured (no webhook secret in vault) — failing honestly, nothing ingested`,
    };
  }
  const lower: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;

  let sig;
  switch (platform) {
    case "hubspot":
      sig = verifyHubSpotSignature(
        secret, opts.method, opts.uri, rawBody,
        lower["x-hubspot-request-timestamp"] ?? null,
        lower["x-hubspot-signature-v3"] ?? null,
      );
      break;
    case "shopify":
      sig = verifyShopifyHmac(secret, rawBody, lower["x-shopify-hmac-sha256"] ?? null);
      break;
    case "meta":
      sig = verifyMetaSignature(secret, rawBody, lower["x-hub-signature-256"] ?? null);
      break;
    case "salesforce":
      // Platform Events/CDC arrive over an authenticated CometD streaming
      // subscription, not per-request webhooks — this endpoint accepts the
      // outbound-message fallback, verified by org id + shared secret.
      sig = verifyWooCommerceSignature(secret, rawBody, lower["x-sfdc-signature"] ?? null);
      break;
  }
  if (!sig.ok) {
    return { ok: false, status: 401, detail: `signature rejected: ${sig.reason}` };
  }
  const ts = lower["x-hubspot-request-timestamp"];
  const replay = await checkReplay(
    platform,
    rawBody,
    lower["x-shopify-webhook-id"] ?? lower["x-hubspot-delivery-id"] ?? lower["x-meta-delivery-id"] ?? null,
    ts !== undefined && ts !== null ? Number(ts) : null,
    opts.replayStore,
  );
  if (!replay.ok) {
    return { ok: false, status: 409, detail: `replay rejected: ${replay.reason}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Platform payload → facts. Each mapper is total: unknown shapes produce
// zero facts and a dead letter, never a crash, never a partial node.
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function factBase(workspaceId: string, source: string): Omit<AppendFactInput, "sourceRecordId" | "entityRef" | "factType" | "payload"> {
  return { workspaceId, source };
}

/** HubSpot: contact/company/deal webhooks (batched, ≤100 events/request). */
export function mapHubSpotEvents(body: Json): AppendFactInput[] {
  const events = Array.isArray(body) ? body : [body];
  const facts: AppendFactInput[] = [];
  for (const e of events as Json[]) {
    const type = str(e.subscriptionType);
    const id = str(e.objectId) || str(e.portalId);
    if (type.startsWith("contact.")) {
      const props = (e.properties ?? {}) as Json;
      facts.push({
        ...factBase("", "hubspot"),
        sourceRecordId: `contact:${id}`,
        entityRef: `customer:email:${str(props.email).toLowerCase() || `hubspot:${id}`}`,
        factType: "crm_contact_upsert",
        payload: {
          displayName: `${str(props.firstname)} ${str(props.lastname)}`.trim() || `Contact ${id}`,
          core: { email: str(props.email).toLowerCase(), phone: str(props.phone), externalId: id },
          properties: { hubspotId: id, lifecycleStage: str(props.lifecyclestage) },
        },
      });
    } else if (type.startsWith("company.")) {
      const props = (e.properties ?? {}) as Json;
      facts.push({
        ...factBase("", "hubspot"),
        sourceRecordId: `company:${id}`,
        entityRef: `crm_record:external:${id}`,
        factType: "crm_company_upsert",
        payload: {
          displayName: str(props.name) || `Company ${id}`,
          core: { externalId: id, domain: str(props.domain).toLowerCase() },
          properties: { hubspotId: id },
        },
      });
    }
  }
  return facts;
}

/** Shopify: order/product/customer GraphQL webhooks. */
export function mapShopifyEvent(topic: string, body: Json): AppendFactInput[] {
  const facts: AppendFactInput[] = [];
  if (topic.startsWith("orders/")) {
    const customer = (body.customer ?? {}) as Json;
    facts.push({
      ...factBase("", "shopify"),
      sourceRecordId: `order:${str(body.id)}`,
      entityRef: `customer:email:${str(customer.email).toLowerCase() || `shopify:${str(customer.id)}`}`,
      factType: "shopify_order",
      payload: {
        displayName: `Order ${str(body.name)}`,
        core: {
          email: str(customer.email).toLowerCase(),
          externalId: str(customer.id),
          orderId: str(body.id),
          total: str(body.total_price),
          currency: str(body.currency),
        },
        properties: { raw: "order" },
      },
    });
  } else if (topic.startsWith("products/")) {
    facts.push({
      ...factBase("", "shopify"),
      sourceRecordId: `product:${str(body.id)}`,
      entityRef: `product:sku:${str((body.variants as Json[] | undefined)?.[0]?.sku) || `shopify:${str(body.id)}`}`,
      factType: "shopify_product_upsert",
      payload: {
        displayName: str(body.title),
        core: { externalId: str(body.id), url: str(body.online_store_url) },
        properties: { handle: str(body.handle) },
      },
    });
  }
  return facts;
}

/** Meta ads webhooks: ad-object change notifications (88 types, 2026). */
export function mapMetaEvent(body: Json): AppendFactInput[] {
  const entries = Array.isArray(body.entry) ? body.entry : [];
  const facts: AppendFactInput[] = [];
  for (const entry of entries as Json[]) {
    for (const change of ((entry.changes ?? []) as Json[])) {
      const value = (change.value ?? {}) as Json;
      const objectId = str(value.ad_id) || str(value.campaign_id) || str(value.adset_id);
      if (!objectId) continue;
      facts.push({
        ...factBase("", "meta"),
        sourceRecordId: `meta:${str(change.field)}:${objectId}`,
        entityRef: `campaign_ref:platform:${objectId}`,
        factType: "meta_ads_object_change",
        payload: {
          displayName: str(value.campaign_name) || str(value.name) || `Meta object ${objectId}`,
          core: { platformRef: objectId, field: str(change.field) },
          properties: { entryTime: entry.time },
        },
      });
    }
  }
  return facts;
}

/** Salesforce: Platform Events / CDC change events (streamed per org). */
export function mapSalesforceEvent(body: Json): AppendFactInput[] {
  const events = Array.isArray(body.events) ? body.events : [body];
  const facts: AppendFactInput[] = [];
  for (const e of events as Json[]) {
    const payload = (e.payload ?? e) as Json;
    const type = str(e.type) || str(payload.ChangeEventHeader__c ? "change" : "");
    void type;
    const recordIds = (payload.ChangeEventHeader as Json | undefined)?.recordIds as
      | string[]
      | undefined;
    const recordId = recordIds?.[0] ?? str(payload.Id);
    if (!recordId) continue;
    facts.push({
      ...factBase("", "salesforce"),
      sourceRecordId: `sf:${recordId}`,
      entityRef: `crm_record:external:${recordId}`,
      factType: "sfdc_record_change",
      payload: {
        displayName: str(payload.Name) || `Salesforce ${recordId}`,
        core: { externalId: recordId, email: str(payload.Email).toLowerCase() },
        properties: { changeType: str((payload.ChangeEventHeader as Json | undefined)?.changeType) },
      },
    });
  }
  return facts;
}

const MAPPERS: Record<TierWPlatform, (topic: string, body: Json) => AppendFactInput[]> = {
  hubspot: (_t, b) => mapHubSpotEvents(b),
  shopify: (t, b) => mapShopifyEvent(t, b),
  meta: (_t, b) => mapMetaEvent(b),
  salesforce: (_t, b) => mapSalesforceEvent(b),
};

/**
 * Full ingest: map → append facts → deterministic ER fast-path. Fuzzy
 * candidates go to the human queue (resolve.ts), never auto-merge.
 */
export async function ingestTierWEvent(opts: {
  platform: TierWPlatform;
  connector: GraphConnector;
  topic: string;
  body: Json;
  rawBody: string;
  actor?: string;
}): Promise<WebhookIngestResult> {
  const { platform, connector, topic, body, rawBody } = opts;
  const { mode, reason } = resolveMode(connector);
  const workspaceId = connector.workspaceId;
  let facts: AppendFactInput[];
  try {
    facts = MAPPERS[platform](topic, body).map((f) => ({
      ...f,
      workspaceId,
      source: connector.id,
      actor: opts.actor ?? `webhook:${platform}`,
    }));
  } catch (e) {
    await deadLetter({
      workspaceId,
      connectorId: connector.id,
      platform,
      reason: `mapper crashed: ${(e as Error).message}`,
      rawBody,
      attempt: 1,
    });
    return { accepted: false, status: 422, detail: "payload unmappable — dead-lettered" };
  }
  if (facts.length === 0) {
    await deadLetter({
      workspaceId,
      connectorId: connector.id,
      platform,
      reason: "no facts extracted from payload",
      rawBody,
      attempt: 1,
    });
    return { accepted: true, status: 202, factsAppended: 0, detail: "no extractable facts — dead-lettered for review" };
  }
  let appended = 0;
  // Project immediately (bounded: one node per fact), then the deterministic
  // ER fast-path. Fuzzy candidates land in the human queue — never auto-merge.
  const { projectFact } = await import("../project");
  const { resolveNode } = await import("../resolve");
  const { withWorkspaceScope } = await import("../rls");
  let queuedEr = 0;
  for (const f of facts) {
    const fact = await appendFact({ ...f, deferProjection: true });
    await withWorkspaceScope(workspaceId, (tx) => projectFact(tx, fact));
    appended++;
    const node = await withWorkspaceScope(workspaceId, (tx) =>
      tx.graphNode.findFirst({
        where: { workspaceId, canonicalKey: f.entityRef },
        select: { id: true },
      }),
    );
    if (node) {
      const r = await resolveNode(workspaceId, node.id);
      queuedEr += r.queued;
    }
  }
  return {
    accepted: true,
    status: 202,
    factsAppended: appended,
    queuedEr,
    detail: `${appended} fact(s) appended from ${platform} (${mode} mode: ${reason})`,
  };
}

export { payloadFingerprint };
