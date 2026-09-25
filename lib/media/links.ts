// Marketr — Phase 5 A1: per-placement QR/pURL link engine.
//
// ABSTRACTED INTERFACE (spec §A1, decision 12.4): Marketr-native self-hosted
// engine is the default. A Dub OSS adapter sits behind the same interface and
// is config-gated — fake in tests. Scan/click data NEVER leaves Marketr's
// database: the native engine stores everything locally; the Dub adapter only
// ever forwards create/update calls, and analytics are computed from the
// local scan ledger regardless of engine.
//
// OAAA PLACEMENT GUIDANCE (spec: guidance belongs in planner copy, not code)
// is published as PLACEMENT_GUIDANCE and returned on link creation so every
// planner surface shows it verbatim.

import { createHash } from "node:crypto";
import type { MediaStore, TrackingLink } from "./store";

export const PLACEMENT_GUIDANCE =
  "Only place QR codes where there is dwell time — transit shelters, street " +
  "furniture, pedestrian streets, malls, waiting areas. Never on highway " +
  "boards (OAAA best practice: \"consider using scan codes on OOH displays " +
  "located in pedestrian-friendly areas\"). Size the code to roughly 10% of " +
  "the expected read distance. Always print a short, human-readable vanity " +
  "URL beside the code for non-scanners.";

// ---------------------------------------------------------------------------
// LinkEngine interface
// ---------------------------------------------------------------------------

export interface CreateLinkInput {
  workspaceId: string;
  buyId?: string | null;
  /** e.g. "board-47", "shelter-main-st-03", "wxyz-morning-drive". */
  placementRef: string;
  /** Optional vanity slug; minted from placementRef when omitted. */
  slug?: string;
  destinationUrl: string;
  /** UTM defaults auto-tagged on every scan redirect. */
  utm?: Record<string, string>;
  /** One vanity short URL + QR per placement (brand.link/board-47). */
  domain?: string;
}

export interface SetDestinationInput {
  workspaceId: string;
  linkId: string;
  destinationUrl: string;
}

export interface ScanInput {
  workspaceId: string;
  slug: string;
  userAgent?: string | null;
  ip?: string | null;
  referer?: string | null;
}

export interface LinkAnalytics {
  link: TrackingLink;
  scansCount: number;
  uniqueIpHashes: number;
  scansByDay: { day: string; scans: number }[];
}

export interface CampaignRollup {
  buyId: string;
  links: number;
  totalScans: number;
  byPlacement: { placementRef: string; slug: string; scans: number }[];
}

export interface LinkEngine {
  readonly name: "marketr" | "dub";
  createLink(input: CreateLinkInput): Promise<TrackingLink>;
  /** Dynamic destination: change the target without reprinting the QR. */
  setDestination(input: SetDestinationInput): Promise<TrackingLink>;
  /** Scan ingress → 302 destination. Records the scan to the local ledger. */
  recordScan(input: ScanInput): Promise<{ destination: string } | null>;
  getAnalytics(workspaceId: string, slug: string): Promise<LinkAnalytics>;
  rollup(workspaceId: string, buyId: string): Promise<CampaignRollup>;
  /** Public URL printed on the creative (e.g. https://brand.link/board-47). */
  publicUrl(link: TrackingLink): string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-_]{1,63}$/i;

export function mintSlug(placementRef: string): string {
  const base = placementRef
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const suffix = createHash("sha256").update(placementRef).digest("hex").slice(0, 6);
  return `${base || "link"}-${suffix}`;
}

export function assertSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) throw new Error(`Invalid slug "${slug}" (letters, digits, - and _)`);
}

export function defaultUtm(input: CreateLinkInput): Record<string, string> {
  return {
    utm_source: "ooh",
    utm_medium: "qr",
    utm_campaign: input.buyId ?? "organic",
    utm_content: input.placementRef,
    ...(input.utm ?? {}),
  };
}

function buildDestination(link: TrackingLink): string {
  const url = new URL(link.destinationUrl);
  for (const [k, v] of Object.entries(link.utm)) {
    if (v) url.searchParams.set(k, v);
  }
  return url.toString();
}

function ipHash(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const salt = new Date().toISOString().slice(0, 10); // daily salt
  return createHash("sha256").update(`${salt}:${ip.trim()}`).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// Marketr-native self-hosted engine (DEFAULT)
// ---------------------------------------------------------------------------

export class MarketrLinkEngine implements LinkEngine {
  readonly name: LinkEngine["name"] = "marketr";
  constructor(
    private store: MediaStore,
    private defaultDomain: string = "link.marketr.local",
  ) {}

  async createLink(input: CreateLinkInput): Promise<TrackingLink> {
    const slug = input.slug ?? mintSlug(input.placementRef);
    assertSlug(slug);
    // Slugs are globally unique: the printed scan URL resolves without a
    // workspace hint, so no internal workspace id ever lands on creative.
    if ((await this.store.getTrackingLinkBySlugAny(slug)).length > 0) {
      throw new Error(`Slug "${slug}" is already taken`);
    }
    let dest: URL;
    try {
      dest = new URL(input.destinationUrl);
    } catch {
      throw new Error("destinationUrl must be an absolute http(s) URL");
    }
    if (dest.protocol !== "https:" && dest.protocol !== "http:") {
      throw new Error("destinationUrl must be an absolute http(s) URL");
    }
    return this.store.createTrackingLink({
      workspaceId: input.workspaceId,
      buyId: input.buyId ?? null,
      placementRef: input.placementRef,
      slug,
      destinationUrl: dest.toString(),
      utm: defaultUtm(input),
      engine: "marketr",
      status: "active",
    });
  }

  async setDestination(input: SetDestinationInput): Promise<TrackingLink> {
    let dest: URL;
    try {
      dest = new URL(input.destinationUrl);
    } catch {
      throw new Error("destinationUrl must be an absolute http(s) URL");
    }
    if (dest.protocol !== "https:" && dest.protocol !== "http:") {
      throw new Error("destinationUrl must be an absolute http(s) URL");
    }
    // Workspace scoping: only touch links in the caller's workspace.
    const owned = (await this.store.listTrackingLinks(input.workspaceId)).find(
      (l) => l.id === input.linkId,
    );
    if (!owned) throw new Error("Link not found in workspace");
    return this.store.updateTrackingLink(input.linkId, { destinationUrl: dest.toString() });
  }

  async recordScan(input: ScanInput): Promise<{ destination: string } | null> {
    // Slugs are globally unique (see createLink), so the printed scan URL
    // resolves without a workspace hint: workspace-scoped first, then global.
    const link =
      (await this.store.getTrackingLinkBySlug(input.workspaceId, input.slug)) ??
      (await this.store.getTrackingLinkBySlugAny(input.slug))[0] ??
      null;
    if (!link || link.status !== "active") return null;
    // Scan/click data stays in Marketr's database — this is the whole point
    // of the self-hosted engine (no third-party redirector sees the event).
    await this.store.recordScanEvent(link.id, {
      occurredAt: new Date(),
      userAgent: (input.userAgent ?? null)?.slice(0, 512) ?? null,
      ipHash: ipHash(input.ip),
      referer: (input.referer ?? null)?.slice(0, 1024) ?? null,
    });
    await this.store.incrementScans(link.id);
    return { destination: buildDestination(link) };
  }

  async getAnalytics(workspaceId: string, slug: string): Promise<LinkAnalytics> {
    const link = await this.store.getTrackingLinkBySlug(workspaceId, slug);
    if (!link) throw new Error(`Link not found: ${slug}`);
    const events = await this.store.listScanEvents(link.id);
    const byDay = new Map<string, number>();
    const ips = new Set<string>();
    for (const e of events) {
      const day = e.occurredAt.toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
      if (e.ipHash) ips.add(e.ipHash);
    }
    return {
      link,
      scansCount: events.length,
      uniqueIpHashes: ips.size,
      scansByDay: [...byDay.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([day, scans]) => ({ day, scans })),
    };
  }

  async rollup(workspaceId: string, buyId: string): Promise<CampaignRollup> {
    const links = await this.store.listTrackingLinks(workspaceId, buyId);
    let total = 0;
    const byPlacement = links.map((l) => {
      total += l.scansCount;
      return { placementRef: l.placementRef, slug: l.slug, scans: l.scansCount };
    });
    byPlacement.sort((a, b) => b.scans - a.scans);
    return { buyId, links: links.length, totalScans: total, byPlacement };
  }

  publicUrl(link: TrackingLink): string {
    return `https://${this.defaultDomain}/${link.slug}`;
  }
}

// ---------------------------------------------------------------------------
// Dub OSS adapter (config-gated, fake in tests)
//
// The Dub adapter forwards link CRUD to a self-hosted Dub OSS instance and
// NEVER reads analytics from Dub: getAnalytics / rollup always compute from
// the local scan ledger, so no scan data egresses to a third party. In fake
// mode (no DUB_BASE_URL) it behaves exactly like the native engine.
// ---------------------------------------------------------------------------

export interface DubConfig {
  baseUrl: string | null; // self-hosted Dub OSS instance; null = fake
  apiKey?: string; // never logged
}

export class DubLinkAdapter extends MarketrLinkEngine {
  readonly name: LinkEngine["name"] = "dub";
  private dub: DubConfig;

  constructor(store: MediaStore, defaultDomain: string, dub: DubConfig) {
    super(store, defaultDomain);
    this.dub = dub;
  }

  /** True when actually talking to Dub OSS (vs fake in tests). */
  get live(): boolean {
    return Boolean(this.dub.baseUrl);
  }

  async createLink(input: CreateLinkInput): Promise<TrackingLink> {
    if (!this.live) return super.createLink(input);
    // Real Dub OSS path: POST /api/links on the self-hosted instance.
    // Kept intentionally thin — the local row is still the source of truth
    // for scans/analytics. (No live Dub instance exists in v1; this branch
    // is unreachable without explicit config + is never exercised in tests.)
    throw new Error("Dub OSS live path requires DUB_BASE_URL + API key configuration");
  }

  async setDestination(input: SetDestinationInput): Promise<TrackingLink> {
    if (!this.live) return super.setDestination(input);
    throw new Error("Dub OSS live path requires DUB_BASE_URL + API key configuration");
  }
}

/** Resolve the configured engine. Fake default; Dub only when configured. */
export function resolveLinkEngine(
  store: MediaStore,
  opts: { domain?: string; dubBaseUrl?: string | null } = {},
): LinkEngine {
  if (opts.dubBaseUrl) {
    return new DubLinkAdapter(store, opts.domain ?? "link.marketr.local", {
      baseUrl: opts.dubBaseUrl,
    });
  }
  return new MarketrLinkEngine(store, opts.domain);
}
