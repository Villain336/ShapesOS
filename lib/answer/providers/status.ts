// ShapesOS — Phase 21A (WS=agentweb): which search providers this server has, for the UI.

import { KNOWN_PROVIDERS } from "./index";
import { BraveProvider } from "./brave";
import { ExaProvider } from "./exa";
import type { ProviderId } from "../types";

export interface ProviderStatus {
  id: ProviderId;
  configured: boolean;
  mock: boolean;
}

export function providerStatus(env: Record<string, string | undefined> = process.env): ProviderStatus[] {
  return KNOWN_PROVIDERS.map((id) => ({
    id,
    mock: id === "mock",
    configured: id === "mock" ? true : id === "brave" ? new BraveProvider({ apiKey: env.BRAVE_SEARCH_API_KEY ?? "" }).isConfigured() : new ExaProvider({ apiKey: env.EXA_API_KEY ?? "" }).isConfigured(),
  }));
}

/** True when no live provider is configured: answers come from sample pages. */
export function mockOnly(env: Record<string, string | undefined> = process.env): boolean {
  return !providerStatus(env).some((p) => !p.mock && p.configured);
}
