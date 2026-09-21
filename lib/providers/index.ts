// Marketr — provider factory (spec §11).
// Today: DataForSEO when credentials exist, mock otherwise.
// To add a supplier: implement SeoDataProvider, add a branch here.

import { DataForSeoProvider } from "./dataforseo";
import { MockSeoProvider } from "./mock";
import type { SeoDataProvider } from "./types";

export function getSeoProvider(): SeoDataProvider {
  const login = (process.env.DATAFORSEO_LOGIN ?? "").trim();
  const password = (process.env.DATAFORSEO_PASSWORD ?? "").trim();
  if (login && password) {
    return new DataForSeoProvider(login, password);
  }
  return new MockSeoProvider();
}

export function providerStatus() {
  const provider = getSeoProvider();
  return {
    name: provider.name,
    isLive: provider.isLive,
    configured: provider.isConfigured(),
  };
}
