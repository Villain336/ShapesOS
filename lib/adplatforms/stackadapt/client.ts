// Marketr — Phase 18 slice 3: StackAdapt GraphQL API client.
//
// Pure network layer: no Prisma, no Next.js imports. fetchImpl is injectable
// so tests run against a mocked StackAdapt API — no live StackAdapt API key
// exists, so the mock path is the verified path.
//
// Endpoint (verified 2026-09-30 against docs.stackadapt.com and the
// introspected public schema):
//   production: POST https://api.stackadapt.com/graphql
//   sandbox:    POST https://sandbox.stackadapt.com/graphql
// Auth: Authorization: Bearer <GraphQL API key>. The GraphQL key is a
// DIFFERENT static key from the REST v2 key (X-Authorization) — the client
// never mixes them. The environment IS the hostname: there is no test/live
// key prefix, so the base URL is asserted before any write.
//
// Hierarchy: Advertiser -> CampaignGroup (the budgeting container) ->
// Campaign (channel-typed interface: native, display, video, ctv, audio,
// dooh) -> Ad.
//
// Two StackAdapt behaviors the client hard-codes:
//   1. userErrors trap — validation failures come back inside a 200 OK
//      payload as `userErrors`, NOT in the top-level `errors` array. Every
//      mutation response is checked for userErrors and treated as FAILED.
//   2. No idempotency key — `upsert*` mutations converge on replay and are
//      safe to retry; `create*` mutations are not retried blindly.
//
// Money: MoneyValue is a decimal STRING in major currency units ("100.57").
// Budgets are passed as strings and normalized to minor units (cents) on
// the way into AdReport.

export class StackAdaptError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "StackAdaptError";
    this.code = code;
    this.status = status;
  }
}

export const STACKADAPT_GRAPHQL_URL = "https://api.stackadapt.com/graphql";
export const STACKADAPT_SANDBOX_GRAPHQL_URL = "https://sandbox.stackadapt.com/graphql";

export interface StackAdaptAuth {
  /** GraphQL API key (NOT the REST v2 key). Never logged — errors carry codes only. */
  apiKey: string;
  /** Full GraphQL endpoint. Defaults to production. */
  baseUrl?: string;
}

export type StackAdaptChannel = "native" | "display" | "video" | "ctv" | "audio" | "dooh";

export const STACKADAPT_CHANNELS: readonly StackAdaptChannel[] = [
  "native",
  "display",
  "video",
  "ctv",
  "audio",
  "dooh",
];

export function isStackAdaptChannel(value: unknown): value is StackAdaptChannel {
  return typeof value === "string" && (STACKADAPT_CHANNELS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Piggyback inventory options (spec §2b)
//
// StackAdapt "also lights up" these surfaces; they are NOT separate
// integrations. They are declared as inventory options on the campaign
// proposal and carried through the scope-hashed payload to execution.
// Channel pairing is validated fail-closed: podcast audio is an audio-channel
// inventory, NCM cinema is video/CTV, newspaper-digital is display/native.
// ---------------------------------------------------------------------------

export interface StackAdaptInventoryOptions {
  /** NCM cinema inventory via PMP deal (video/ctv channels only). */
  cinemaPmp?: boolean;
  /** Newspaper-digital inventory (display/native channels only). */
  newspaperDigital?: boolean;
  /** Programmatic podcast audio inventory (audio channel only). */
  podcastAudio?: boolean;
}

const INVENTORY_FLAGS = ["cinemaPmp", "newspaperDigital", "podcastAudio"] as const;

export function parseInventoryOptions(
  input: unknown,
  channel: StackAdaptChannel,
): StackAdaptInventoryOptions {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new StackAdaptError("INVALID_PAYLOAD", "inventory must be an object of inventory flags");
  }
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!(INVENTORY_FLAGS as readonly string[]).includes(key)) {
      throw new StackAdaptError(
        "INVALID_PAYLOAD",
        `Unknown inventory option "${key}" — allowed: ${INVENTORY_FLAGS.join(", ")}`,
      );
    }
    if (typeof raw[key] !== "boolean") {
      throw new StackAdaptError("INVALID_PAYLOAD", `Inventory option "${key}" must be a boolean`);
    }
  }
  const opts = raw as StackAdaptInventoryOptions;
  if (opts.podcastAudio && channel !== "audio") {
    throw new StackAdaptError(
      "INVALID_PAYLOAD",
      "podcastAudio inventory requires the audio channel",
    );
  }
  if (opts.cinemaPmp && channel !== "video" && channel !== "ctv") {
    throw new StackAdaptError(
      "INVALID_PAYLOAD",
      "cinemaPmp inventory requires the video or ctv channel",
    );
  }
  if (opts.newspaperDigital && channel !== "display" && channel !== "native") {
    throw new StackAdaptError(
      "INVALID_PAYLOAD",
      "newspaperDigital inventory requires the display or native channel",
    );
  }
  return {
    ...(opts.cinemaPmp ? { cinemaPmp: true } : {}),
    ...(opts.newspaperDigital ? { newspaperDigital: true } : {}),
    ...(opts.podcastAudio ? { podcastAudio: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Money + date helpers
// ---------------------------------------------------------------------------

/** Minor units (cents) → MoneyValue decimal string in major units. */
export function centsToMajorString(cents: number): string {
  return (Math.round(cents) / 100).toFixed(2);
}

/** MoneyValue decimal string → minor units (cents), rounded. */
export function majorStringToCents(major: string): number {
  const n = Number(major);
  if (!Number.isFinite(n)) {
    throw new StackAdaptError("BAD_RESPONSE", `Invalid MoneyValue: ${JSON.stringify(major)}`);
  }
  return Math.round(n * 100);
}

function assertDate(yyyymmdd: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(yyyymmdd)) {
    throw new StackAdaptError("INVALID_INPUT", `${field} must be YYYY-MM-DD`);
  }
}

// ---------------------------------------------------------------------------
// GraphQL documents
// ---------------------------------------------------------------------------

const TOKEN_INFO_QUERY = `query TokenInfo { tokenInfo { __typename } }`;

const ADVERTISERS_QUERY = `query Advertisers($first: Int!, $after: String) {
  advertisers(first: $first, after: $after) {
    totalCount
    nodes { id name isArchived }
    pageInfo { hasNextPage endCursor }
  }
}`;

const CAMPAIGNS_QUERY = `query Campaigns($first: Int!, $after: String) {
  campaigns(first: $first, after: $after) {
    totalCount
    nodes {
      __typename
      id
      campaignStatus
      channelType
      campaignGroup { id name }
      advertiser { id name }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const CAMPAIGN_QUERY = `query Campaign($id: ID!) {
  campaign(id: $id) {
    __typename
    id
    campaignStatus
    channelType
    campaignGroup { id name }
    advertiser { id name }
  }
}`;

const CREATE_CAMPAIGN_GROUP_MUTATION = `mutation CreateCampaignGroup($input: CreateCampaignGroupInput!) {
  createCampaignGroup(input: $input) {
    campaignGroup { id name }
    userErrors { message path }
  }
}`;

const UPSERT_CAMPAIGN_MUTATION = `mutation UpsertCampaign($input: CampaignInput!) {
  upsertCampaign(input: $input) {
    campaign { __typename id campaignStatus channelType }
    userErrors { message path }
  }
}`;

const PAUSE_CAMPAIGNS_MUTATION = `mutation PauseCampaigns($ids: [ID!]!) {
  pauseCampaigns(ids: $ids) {
    userErrors { message path }
  }
}`;

/**
 * Budget adjust. The campaign group is the budgeting container. This mutation
 * is MODELED on createCampaignGroup — it could NOT be verified against the
 * live schema (docs sit behind a login), so a live failure here throws
 * UNVERIFIED_BUDGET_MUTATION rather than silently mis-setting a budget.
 */
const UPDATE_CAMPAIGN_GROUP_BUDGET_MUTATION = `mutation UpdateCampaignGroupBudget($input: UpdateCampaignGroupInput!) {
  updateCampaignGroup(input: $input) {
    campaignGroup { id name }
    userErrors { message path }
  }
}`;

/**
 * Delivery reporting. campaignDelivery is the verified forward-path query;
 * the exact argument/input shape is modeled on the public docs and could
 * NOT be verified against the live schema — treated as UNVERIFIED like the
 * budget mutation if the platform rejects it.
 */
const CAMPAIGN_DELIVERY_QUERY = `query CampaignDelivery($input: CampaignDeliveryInput!) {
  campaignDelivery(input: $input) {
    records {
      date
      campaign { id }
      impressions
      clicks
      cost
      conversions
      revenue
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StackAdaptAdvertiser {
  id: string;
  name?: string;
  isArchived?: boolean;
}

export interface StackAdaptCampaign {
  __typename?: string;
  id: string;
  campaignStatus?: string;
  channelType?: string;
  campaignGroup?: { id: string; name?: string } | null;
  advertiser?: { id: string; name?: string } | null;
}

export interface RelayPage<T> {
  nodes: T[];
  totalCount?: number;
  hasNextPage: boolean;
  endCursor?: string | null;
}

export interface CreateCampaignGroupInput {
  advertiserId: string;
  name: string;
  /** Daily budget in minor units (cents) — converted to a MoneyValue string. */
  dailyBudgetCents: number;
  /** YYYY-MM-DD. */
  startDate: string;
  /** YYYY-MM-DD. */
  endDate?: string;
  timezone?: string;
}

export interface UpsertCampaignInput {
  /** Present when updating an existing campaign; absent = create. */
  id?: string;
  campaignGroupId: string;
  channel: StackAdaptChannel;
  name: string;
  /** Create paused (QA first, human activates). Defaults to paused — safe. */
  paused?: boolean;
}

/** A modeled day-grain delivery record from campaignDelivery. */
export interface StackAdaptDeliveryRecord {
  /** YYYY-MM-DD. */
  date: string;
  campaignId: string;
  impressions: number;
  clicks: number;
  /** MoneyValue decimal string, major units. */
  cost: string;
  conversions: number;
  /** MoneyValue decimal string, major units. */
  revenue: string;
}

export interface StackAdaptClientOptions {
  auth: StackAdaptAuth;
  fetchImpl?: typeof fetch;
}

interface UserError {
  message?: string;
  path?: string[];
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class StackAdaptClient {
  private readonly auth: StackAdaptAuth;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: StackAdaptClientOptions) {
    if (!options.auth?.apiKey || !options.auth.apiKey.trim()) {
      throw new StackAdaptError("MISSING_AUTH", "StackAdapt GraphQL API key is required");
    }
    this.auth = options.auth;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = (options.auth.baseUrl ?? STACKADAPT_GRAPHQL_URL).replace(/\/+$/, "");
  }

  get endpoint(): string {
    return this.baseUrl;
  }

  /** Assert the environment before any write — the hostname IS the env. */
  private assertWriteEnvironment(): void {
    if (this.baseUrl !== STACKADAPT_GRAPHQL_URL && this.baseUrl !== STACKADAPT_SANDBOX_GRAPHQL_URL) {
      throw new StackAdaptError(
        "UNKNOWN_ENVIRONMENT",
        "Refusing to write: GraphQL endpoint is neither production nor the sandbox URL",
      );
    }
  }

  private async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers: {
          // The GraphQL key is NOT the REST v2 key — never send X-Authorization here.
          Authorization: `Bearer ${this.auth.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (e) {
      throw new StackAdaptError(
        "NETWORK",
        `StackAdapt request failed: ${e instanceof Error ? e.message : "network error"}`,
      );
    }
    if (!res.ok) {
      // Never log the key: only the status and the platform's error message.
      let detail = "";
      try {
        const errBody = (await res.json()) as {
          errors?: Array<{ message?: string; extensions?: { traceId?: string } }>;
          error?: string;
        };
        const first = errBody?.errors?.[0];
        if (typeof first?.message === "string") detail = `: ${first.message}`;
        else if (typeof errBody?.error === "string") detail = `: ${errBody.error}`;
      } catch {
        /* non-JSON error body — status alone is enough */
      }
      if (res.status === 401) {
        throw new StackAdaptError(
          "AUTH_FAILED",
          `StackAdapt auth failed (HTTP 401) — the GraphQL API key is missing or invalid${detail}`,
          401,
        );
      }
      if (res.status === 429) {
        throw new StackAdaptError("RATE_LIMITED", `StackAdapt rate limited (HTTP 429)${detail}`, 429);
      }
      throw new StackAdaptError("API_ERROR", `StackAdapt API error (HTTP ${res.status})${detail}`, res.status);
    }
    let body: { data?: T; errors?: Array<{ message?: string; extensions?: { traceId?: string } }> };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new StackAdaptError("BAD_RESPONSE", "StackAdapt returned a non-JSON response");
    }
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      const first = body.errors[0];
      const trace = first?.extensions?.traceId ? ` (traceId ${first.extensions.traceId})` : "";
      throw new StackAdaptError("API_ERROR", `StackAdapt GraphQL error: ${first?.message ?? "unknown"}${trace}`);
    }
    if (body.data === undefined || body.data === null) {
      throw new StackAdaptError("BAD_RESPONSE", "StackAdapt returned no data");
    }
    return body.data;
  }

  /**
   * Run a mutation and enforce the userErrors trap: validation failures come
   * back inside the 200 OK payload, so a missing check would record a
   * rejection as a success.
   */
  private async mutate<P extends Record<string, unknown>, R>(
    mutationName: string,
    document: string,
    variables: Record<string, unknown>,
    pick: (payload: P & { userErrors?: UserError[] | null }) => R,
  ): Promise<R> {
    this.assertWriteEnvironment();
    const data = await this.graphql<Record<string, P | null>>(document, variables);
    const raw = data[mutationName];
    if (!raw) {
      throw new StackAdaptError("MUTATION_FAILED", `StackAdapt mutation "${mutationName}" returned no payload`);
    }
    const payload = raw as P & { userErrors?: UserError[] | null };
    if (payload.userErrors && payload.userErrors.length > 0) {
      const first = payload.userErrors[0];
      const path = first?.path?.length ? ` (${first.path.join(".")})` : "";
      throw new StackAdaptError(
        "USER_ERROR",
        `StackAdapt rejected the mutation: ${first?.message ?? "validation failed"}${path}`,
      );
    }
    return pick(payload);
  }

  // -- account ---------------------------------------------------------------

  /** The "account read" — also the auth check: a bad key 401s here. */
  async checkAuth(): Promise<void> {
    await this.graphql<{ tokenInfo?: { __typename?: string } }>(TOKEN_INFO_QUERY);
  }

  async listAdvertisers(input: { first?: number; after?: string } = {}): Promise<RelayPage<StackAdaptAdvertiser>> {
    const data = await this.graphql<{
      advertisers?: {
        totalCount?: number;
        nodes?: StackAdaptAdvertiser[];
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      } | null;
    }>(ADVERTISERS_QUERY, { first: input.first ?? 50, ...(input.after ? { after: input.after } : {}) });
    const conn = data.advertisers;
    if (!conn) throw new StackAdaptError("BAD_RESPONSE", "StackAdapt advertisers response was empty");
    return {
      nodes: conn.nodes ?? [],
      totalCount: conn.totalCount,
      hasNextPage: conn.pageInfo?.hasNextPage ?? false,
      endCursor: conn.pageInfo?.endCursor,
    };
  }

  // -- campaigns ---------------------------------------------------------------

  async listCampaigns(input: { first?: number; after?: string } = {}): Promise<RelayPage<StackAdaptCampaign>> {
    const data = await this.graphql<{
      campaigns?: {
        totalCount?: number;
        nodes?: StackAdaptCampaign[];
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      } | null;
    }>(CAMPAIGNS_QUERY, { first: input.first ?? 50, ...(input.after ? { after: input.after } : {}) });
    const conn = data.campaigns;
    if (!conn) throw new StackAdaptError("BAD_RESPONSE", "StackAdapt campaigns response was empty");
    return {
      nodes: conn.nodes ?? [],
      totalCount: conn.totalCount,
      hasNextPage: conn.pageInfo?.hasNextPage ?? false,
      endCursor: conn.pageInfo?.endCursor,
    };
  }

  async getCampaign(id: string): Promise<StackAdaptCampaign | null> {
    if (!id) throw new StackAdaptError("INVALID_INPUT", "campaign id is required");
    const data = await this.graphql<{ campaign?: StackAdaptCampaign | null }>(CAMPAIGN_QUERY, { id });
    return data.campaign ?? null;
  }

  /**
   * Create the campaign group — StackAdapt's budgeting container. Reads are
   * never asserted to an environment; writes fail closed on unknown hosts.
   */
  async createCampaignGroup(input: CreateCampaignGroupInput): Promise<{ id: string; name?: string }> {
    if (!input.advertiserId?.trim()) throw new StackAdaptError("INVALID_INPUT", "advertiserId is required");
    if (!input.name?.trim()) throw new StackAdaptError("INVALID_INPUT", "campaign group name is required");
    if (!Number.isFinite(input.dailyBudgetCents) || input.dailyBudgetCents <= 0) {
      throw new StackAdaptError("INVALID_INPUT", "dailyBudgetCents must be a positive number");
    }
    assertDate(input.startDate, "startDate");
    if (input.endDate) assertDate(input.endDate, "endDate");
    return this.mutate(
      "createCampaignGroup",
      CREATE_CAMPAIGN_GROUP_MUTATION,
      {
        input: {
          advertiserId: input.advertiserId,
          name: input.name.trim(),
          budgetType: "DAILY",
          budgetAllocation: centsToMajorString(input.dailyBudgetCents),
          pacing: "EVEN",
          flights: [
            {
              startDate: input.startDate,
              ...(input.endDate ? { endDate: input.endDate } : {}),
            },
          ],
          ...(input.timezone ? { timezone: input.timezone } : {}),
        },
      },
      (payload: { campaignGroup?: { id?: string; name?: string } | null }) => {
        if (!payload.campaignGroup?.id) {
          throw new StackAdaptError("CREATE_FAILED", "createCampaignGroup returned no campaign group id");
        }
        return { id: payload.campaignGroup.id, name: payload.campaignGroup.name };
      },
    );
  }

  /**
   * Create or update the channel campaign inside a group. upsertCampaign is
   * the idempotent form — safe to retry against an existing id.
   */
  async upsertCampaign(input: UpsertCampaignInput): Promise<StackAdaptCampaign> {
    if (!isStackAdaptChannel(input.channel)) {
      throw new StackAdaptError(
        "UNSUPPORTED_CHANNEL",
        `Channel "${String(input.channel)}" is not supported — one of: ${STACKADAPT_CHANNELS.join(", ")}`,
      );
    }
    if (!input.campaignGroupId?.trim()) throw new StackAdaptError("INVALID_INPUT", "campaignGroupId is required");
    if (!input.name?.trim()) throw new StackAdaptError("INVALID_INPUT", "campaign name is required");
    return this.mutate(
      "upsertCampaign",
      UPSERT_CAMPAIGN_MUTATION,
      {
        input: {
          ...(input.id ? { id: input.id } : {}),
          campaignGroupId: input.campaignGroupId,
          channelType: input.channel.toUpperCase(),
          name: input.name.trim(),
          paused: input.paused ?? true,
        },
      },
      (payload: { campaign?: StackAdaptCampaign | null }) => {
        if (!payload.campaign?.id) {
          throw new StackAdaptError("CREATE_FAILED", "upsertCampaign returned no campaign id");
        }
        return payload.campaign;
      },
    );
  }

  /** Pause delivery. Resume is deliberately NOT wired — resuming is a judgment call, never automated. */
  async pauseCampaigns(ids: string[]): Promise<void> {
    if (!ids.length) throw new StackAdaptError("INVALID_INPUT", "At least one campaign id is required to pause");
    await this.mutate("pauseCampaigns", PAUSE_CAMPAIGNS_MUTATION, { ids }, () => undefined);
  }

  /**
   * Budget adjust on the campaign group. UNVERIFIED: the exact
   * updateCampaignGroup input shape could not be confirmed against the live
   * schema, so a platform rejection throws UNVERIFIED_BUDGET_MUTATION
   * instead of silently mis-setting a budget.
   */
  async setCampaignGroupBudget(campaignGroupId: string, dailyBudgetCents: number): Promise<void> {
    if (!campaignGroupId?.trim()) throw new StackAdaptError("INVALID_INPUT", "campaignGroupId is required");
    if (!Number.isFinite(dailyBudgetCents) || dailyBudgetCents <= 0) {
      throw new StackAdaptError("INVALID_INPUT", "dailyBudgetCents must be a positive number");
    }
    try {
      await this.mutate(
        "updateCampaignGroup",
        UPDATE_CAMPAIGN_GROUP_BUDGET_MUTATION,
        {
          input: {
            id: campaignGroupId,
            budgetType: "DAILY",
            budgetAllocation: centsToMajorString(dailyBudgetCents),
          },
        },
        () => undefined,
      );
    } catch (e) {
      if (
        e instanceof StackAdaptError &&
        (e.code === "API_ERROR" || e.code === "USER_ERROR" || e.code === "MUTATION_FAILED")
      ) {
        throw new StackAdaptError(
          "UNVERIFIED_BUDGET_MUTATION",
          `StackAdapt rejected the budget mutation — the updateCampaignGroup shape is unverified against the live schema. Verify, then retry. (${e.code})`,
        );
      }
      throw e;
    }
  }

  // -- reporting ---------------------------------------------------------------

  /**
   * Day-grain delivery records for campaigns in a date range. The
   * CampaignDeliveryInput shape is modeled on the public docs and is
   * UNVERIFIED against the live schema — a rejection throws
   * UNVERIFIED_REPORTING_QUERY.
   */
  async campaignDelivery(input: {
    campaignIds?: string[];
    startDate: string;
    endDate: string;
    after?: string;
  }): Promise<RelayPage<StackAdaptDeliveryRecord>> {
    assertDate(input.startDate, "startDate");
    assertDate(input.endDate, "endDate");
    let data: {
      campaignDelivery?: {
        records?: Array<Record<string, unknown>>;
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      } | null;
    };
    try {
      data = await this.graphql(CAMPAIGN_DELIVERY_QUERY, {
        input: {
          ...(input.campaignIds?.length ? { campaignIds: input.campaignIds } : {}),
          startDate: input.startDate,
          endDate: input.endDate,
          groupBy: ["DAY", "CAMPAIGN"],
          ...(input.after ? { after: input.after } : {}),
        },
      });
    } catch (e) {
      if (e instanceof StackAdaptError && e.code === "API_ERROR") {
        throw new StackAdaptError(
          "UNVERIFIED_REPORTING_QUERY",
          `StackAdapt rejected the delivery query — the campaignDelivery shape is unverified against the live schema. Verify, then retry.`,
        );
      }
      throw e;
    }
    const conn = data.campaignDelivery;
    if (!conn) throw new StackAdaptError("BAD_RESPONSE", "StackAdapt campaignDelivery response was empty");
    return {
      nodes: (conn.records ?? []).map((r, i) => parseDeliveryRecord(r, i)),
      hasNextPage: conn.pageInfo?.hasNextPage ?? false,
      endCursor: conn.pageInfo?.endCursor,
    };
  }
}

function parseDeliveryRecord(raw: Record<string, unknown>, i: number): StackAdaptDeliveryRecord {
  const date = raw.date;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new StackAdaptError("BAD_RESPONSE", `StackAdapt delivery record ${i} has an invalid date`);
  }
  const campaign = raw.campaign as { id?: unknown } | undefined;
  const campaignId = campaign?.id;
  if (typeof campaignId !== "string" || !campaignId) {
    throw new StackAdaptError("BAD_RESPONSE", `StackAdapt delivery record ${i} has no campaign id`);
  }
  for (const field of ["impressions", "clicks", "conversions"] as const) {
    const n = Number(raw[field] ?? 0);
    if (!Number.isFinite(n)) {
      throw new StackAdaptError("BAD_RESPONSE", `StackAdapt delivery record ${i} has non-numeric ${field}`);
    }
  }
  for (const field of ["cost", "revenue"] as const) {
    if (typeof raw[field] !== "string" || !Number.isFinite(Number(raw[field]))) {
      throw new StackAdaptError("BAD_RESPONSE", `StackAdapt delivery record ${i} has an invalid ${field} MoneyValue`);
    }
  }
  return {
    date,
    campaignId,
    impressions: Math.round(Number(raw.impressions ?? 0)),
    clicks: Math.round(Number(raw.clicks ?? 0)),
    cost: String(raw.cost),
    conversions: Number(raw.conversions ?? 0),
    revenue: String(raw.revenue),
  };
}
