// Marketr — provider factory (spec §11).
// Today: DataForSEO when credentials exist, mock otherwise.
// To add a supplier: implement SeoDataProvider, add a branch here.

import { DataForSeoProvider } from "./dataforseo";
import { MockSeoProvider } from "./mock";
import type { SeoDataProvider } from "./types";
import { FakeProviderRefusedError, fakeProvidersAllowed } from "@/lib/env/secrets";

export function getSeoProvider(): SeoDataProvider {
  const login = (process.env.DATAFORSEO_LOGIN ?? "").trim();
  const password = (process.env.DATAFORSEO_PASSWORD ?? "").trim();
  if (login && password) {
    return new DataForSeoProvider(login, password);
  }
  // Phase 11 (conncore): no labelled mock rows in production — every data
  // call says "not connected" instead (lib/connectors/no-fakes.ts).
  if (!fakeProvidersAllowed()) return new NotConnectedSeoProvider();
  return new MockSeoProvider();
}

/** Phase 11 (conncore): production stand-in when DataForSEO is not configured. */
export class NotConnectedSeoProvider implements SeoDataProvider {
  readonly name = "not_connected";
  readonly isLive = false;
  isConfigured(): boolean {
    return false;
  }
  private refuse(): never {
    throw new FakeProviderRefusedError("SEO data (DataForSEO)");
  }
  keywordIdeas = async (): Promise<never> => this.refuse();
  competitorKeywords = async (): Promise<never> => this.refuse();
  serpResults = async (): Promise<never> => this.refuse();
  backlinks = async (): Promise<never> => this.refuse();
  backlinksSummary = async (): Promise<never> => this.refuse();
  mapsSerp = async (): Promise<never> => this.refuse();
  businessListings = async (): Promise<never> => this.refuse();
  businessReviews = async (): Promise<never> => this.refuse();
}

export function providerStatus() {
  const provider = getSeoProvider();
  return {
    name: provider.name,
    isLive: provider.isLive,
    configured: provider.isConfigured(),
  };
}
