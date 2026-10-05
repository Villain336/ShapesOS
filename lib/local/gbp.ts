// Marketr — Google Business Profile management scaffold (milestone 16).
//
// EVERYTHING here stays behind the FEATURE_GBP_MANAGEMENT flag. This file
// holds the contract + the mock provider (no network). Phase 4b: the live
// provider (localPosts list/create, Performance API daily metrics) is
// lib/local/gbp-live.ts, selected per workspace by gbpProviderForWorkspace()
// when the workspace has a Google Business Profile OAuth connection.

export interface GbpPostInput {
  locationId: string;
  title: string;
  summary: string;
  /** "call" | "learn_more" | "book" | "order" | "shop" | null */
  callToAction?: string | null;
  actionUrl?: string | null;
  scheduledAt?: Date | null;
}

export interface GbpPost {
  id: string;
  locationId: string;
  title: string;
  summary: string;
  status: "draft" | "scheduled" | "published" | "failed";
  scheduledAt: string | null;
  /** true for the mock provider; false for live provider rows. */
  mock: boolean;
}

export interface GbpInsight {
  locationId: string;
  date: string; // yyyy-mm-dd
  views: number;
  searches: number;
  directionRequests: number;
  calls: number;
  websiteClicks: number;
}

export interface GbpProvider {
  readonly name: string;
  readonly isLive: boolean;
  isConfigured(): boolean;
  listPosts(locationId: string): Promise<GbpPost[]>;
  createPost(input: GbpPostInput): Promise<GbpPost>;
  insights(locationId: string, days?: number): Promise<GbpInsight[]>;
}

/** FEATURE_GBP_MANAGEMENT must be "true" AND credentials present. */
export function gbpManagementEnabled(): boolean {
  return (process.env.FEATURE_GBP_MANAGEMENT ?? "").trim().toLowerCase() === "true";
}

export class MockGbpProvider implements GbpProvider {
  readonly name = "mock-gbp";
  readonly isLive = false;

  isConfigured(): boolean {
    return gbpManagementEnabled();
  }

  async listPosts(locationId: string): Promise<GbpPost[]> {
    return [
      {
        id: "mock-post-1",
        locationId,
        title: "Spring service special",
        summary: "Mock GBP post — 20% off seasonal checkups this month.",
        status: "published",
        scheduledAt: new Date(Date.now() - 6 * 86400000).toISOString(),
        mock: true,
      },
      {
        id: "mock-post-2",
        locationId,
        title: "Now booking next week",
        summary: "Mock GBP post — draft for the weekly offer cadence.",
        status: "draft",
        scheduledAt: null,
        mock: true,
      },
    ];
  }

  async createPost(input: GbpPostInput): Promise<GbpPost> {
    return {
      id: `mock-post-${Date.now()}`,
      locationId: input.locationId,
      title: input.title,
      summary: input.summary,
      status: input.scheduledAt ? "scheduled" : "draft",
      scheduledAt: input.scheduledAt ? input.scheduledAt.toISOString() : null,
      mock: true,
    };
  }

  async insights(locationId: string, days = 30): Promise<GbpInsight[]> {
    const out: GbpInsight[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const seed = i * 37 + locationId.length;
      out.push({
        locationId,
        date: d.toISOString().slice(0, 10),
        views: 40 + ((seed * 13) % 120),
        searches: 20 + ((seed * 7) % 60),
        directionRequests: 3 + ((seed * 5) % 15),
        calls: 1 + ((seed * 3) % 8),
        websiteClicks: 5 + ((seed * 11) % 30),
        // mock: true is implied by provider name; rows are labeled in UI.
      });
    }
    return out;
  }
}

/**
 * The mock provider. Routes use gbpProviderForWorkspace() (lib/local/gbp-live.ts),
 * which returns the live provider when the workspace has connected GBP.
 */
export function getGbpProvider(): GbpProvider {
  return new MockGbpProvider();
}
