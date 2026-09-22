// Marketr — Buffer port (milestone 20).
//
// Thin wrapper around the Buffer v1 REST API (https://api.bufferapp.com/1)
// so the social service never touches HTTP directly: tests inject
// MockBufferPort (no network, no spend) and production injects
// createBufferPort(decryptedAccessToken).
//
// Access token model: the workspace stores a Buffer access token (Buffer
// dashboard → Manage Apps → access token) encrypted at rest. Buffer's
// OAuth flow is documented for multi-user SaaS installs; the token model
// matches Marketr's BYO-credential pattern (same as Resend in milestone 19).

export interface BufferProfile {
  id: string;
  /** Buffer service key: twitter, facebook, instagram, linkedin, tiktok, ... */
  service: string;
  serviceUsername?: string;
  formattedUsername?: string;
  avatar?: string;
}

export interface BufferUpdate {
  id: string;
  profileId: string;
  /** pending | sent | ... (Buffer's status values) */
  status: string;
  createdAt?: string;
  dueAt?: string;
}

export interface BufferInteractions {
  likes?: number;
  shares?: number;
  comments?: number;
  clicks?: number;
  reach?: number;
  retweets?: number;
}

export interface CreateUpdateArgs {
  text: string;
  /** Link attachment. */
  link?: string;
  /** Public image URL (Buffer media[photo]). */
  photo?: string;
  /** Schedule as ISO 8601; when set, the update is queued for that time. */
  scheduledAt?: string;
  /** Publish immediately instead of scheduling. */
  now?: boolean;
}

export interface BufferPort {
  listProfiles(): Promise<BufferProfile[]>;
  /** One call per channel (per-channel text overrides need separate calls). */
  createUpdate(profileId: string, args: CreateUpdateArgs): Promise<BufferUpdate>;
  /** Fetch a single update (used to observe sent status). */
  getUpdate(updateId: string): Promise<BufferUpdate>;
  /** Delete a pending update (cancel). */
  deleteUpdate(updateId: string): Promise<void>;
  /** Per-update engagement (likes/shares/comments/clicks where provided). */
  getInteractions(updateId: string): Promise<BufferInteractions>;
}

const BUFFER_API_BASE = "https://api.bufferapp.com/1";

async function throwIfBufferError(res: Response, op: string): Promise<void> {
  if (res.ok) return;
  const retryAfter = res.headers.get("retry-after");
  const body = await res.text().catch(() => "");
  const err = new Error(`Buffer ${op} failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  (err as { status?: number }).status = res.status;
  (err as { retryAfter?: string | null }).retryAfter = retryAfter;
  throw err;
}

/** Classify an HTTP failure as transient (worth retrying) or permanent. */
export function isTransientBufferError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 429) return true;
  if (status !== undefined) return status >= 500;
  // Network-level failure (fetch threw): treat as transient.
  return true;
}

function toUpdate(raw: Record<string, unknown>, profileId: string): BufferUpdate {
  return {
    id: String(raw.id ?? ""),
    profileId: String((raw.profile_id as string | undefined) ?? profileId),
    status: String((raw.status as string | undefined) ?? "pending"),
    createdAt: (raw.created_at as string | undefined) ?? undefined,
    dueAt: (raw.due_at as string | undefined) ?? undefined,
  };
}

/** Production port backed by fetch against the Buffer v1 REST API. */
export function createBufferPort(accessToken: string): BufferPort {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };

  async function request(path: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(`${BUFFER_API_BASE}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers ?? {}) },
    });
    await throwIfBufferError(res, `${init?.method ?? "GET"} ${path}`);
    return res.json();
  }

  return {
    async listProfiles(): Promise<BufferProfile[]> {
      const raw = (await request("/profiles.json")) as Array<Record<string, unknown>>;
      return (Array.isArray(raw) ? raw : []).map((p) => ({
        id: String(p.id ?? ""),
        service: String(p.service ?? ""),
        serviceUsername: (p.service_username as string | undefined) ?? undefined,
        formattedUsername: (p.formatted_username as string | undefined) ?? undefined,
        avatar: (p.avatar as string | undefined) ?? undefined,
      }));
    },

    async createUpdate(profileId: string, args: CreateUpdateArgs): Promise<BufferUpdate> {
      const body = new URLSearchParams();
      body.set("profile_ids[]", profileId);
      body.set("text", args.text);
      body.set("shorten", "false");
      if (args.link) {
        body.set("media[link]", args.link);
      }
      if (args.photo) {
        body.set("media[photo]", args.photo);
      }
      if (args.now) {
        body.set("now", "true");
      } else if (args.scheduledAt) {
        body.set("scheduled_at", args.scheduledAt);
      }
      const raw = (await request("/updates/create.json", { method: "POST", body })) as Record<
        string,
        unknown
      >;
      const updates = raw.updates as Array<Record<string, unknown>> | undefined;
      if (!updates || updates.length === 0) {
        throw new Error("Buffer createUpdate returned no updates.");
      }
      return toUpdate(updates[0], profileId);
    },

    async getUpdate(updateId: string): Promise<BufferUpdate> {
      const raw = (await request(`/updates/${encodeURIComponent(updateId)}.json`)) as Record<
        string,
        unknown
      >;
      return toUpdate(raw, "");
    },

    async deleteUpdate(updateId: string): Promise<void> {
      await request(`/updates/${encodeURIComponent(updateId)}/destroy.json`, { method: "POST" });
    },

    async getInteractions(updateId: string): Promise<BufferInteractions> {
      const raw = (await request(
        `/updates/${encodeURIComponent(updateId)}/interactions.json`,
      )) as Record<string, unknown>;
      const num = (v: unknown): number | undefined =>
        typeof v === "number" && Number.isFinite(v) ? v : undefined;
      return {
        likes: num(raw.likes),
        shares: num(raw.shares),
        comments: num(raw.comments),
        clicks: num(raw.clicks),
        reach: num(raw.reach),
        retweets: num(raw.retweets),
      };
    },
  };
}

/**
 * In-memory mock for tests. Supports scripted failures: failWith(fn) makes the
 * next N calls throw, and per-call overrides let fixture tests exercise
 * transient-vs-permanent retry semantics without any network.
 */
export class MockBufferPort implements BufferPort {
  profiles: BufferProfile[] = [];
  created: Array<{ profileId: string; args: CreateUpdateArgs }> = [];
  deleted: string[] = [];
  /** updateId -> status, mutated to "sent" by advance(). */
  private updateStatus = new Map<string, string>();
  interactions: Record<string, BufferInteractions> = {};
  private failQueue: Array<() => Error> = [];
  private seq = 0;

  failNext(n: number, makeError: () => Error): void {
    for (let i = 0; i < n; i++) this.failQueue.push(makeError);
  }

  private maybeFail(op: string): void {
    const make = this.failQueue.shift();
    if (make) throw make();
    void op;
  }

  addProfile(p: BufferProfile): void {
    this.profiles.push(p);
  }

  async listProfiles(): Promise<BufferProfile[]> {
    this.maybeFail("listProfiles");
    return [...this.profiles];
  }

  async createUpdate(profileId: string, args: CreateUpdateArgs): Promise<BufferUpdate> {
    this.maybeFail("createUpdate");
    this.seq += 1;
    const id = `mock-update-${this.seq}`;
    this.created.push({ profileId, args });
    this.updateStatus.set(id, args.now ? "sent" : "pending");
    return { id, profileId, status: args.now ? "sent" : "pending" };
  }

  async getUpdate(updateId: string): Promise<BufferUpdate> {
    this.maybeFail("getUpdate");
    const status = this.updateStatus.get(updateId) ?? "pending";
    return { id: updateId, profileId: "", status };
  }

  async deleteUpdate(updateId: string): Promise<void> {
    this.maybeFail("deleteUpdate");
    this.deleted.push(updateId);
    this.updateStatus.delete(updateId);
  }

  async getInteractions(updateId: string): Promise<BufferInteractions> {
    this.maybeFail("getInteractions");
    return this.interactions[updateId] ?? {};
  }

  /** Simulate time passing: every pending update flips to sent. */
  advance(): void {
    for (const [id, status] of this.updateStatus) {
      if (status === "pending") this.updateStatus.set(id, "sent");
    }
  }
}
