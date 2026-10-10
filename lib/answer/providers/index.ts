// ShapesOS — Phase 21A (WS=agentweb): which search providers run, and in what order.
//
// Platform keys (live class, metered in credits):
//   BRAVE_SEARCH_API_KEY   Brave Search API (own index)
//   EXA_API_KEY            Exa (semantic search)
// Neither exists yet: until one does, the answer engine runs on the labelled mock
// provider and says so. A workspace can choose the order (agentweb_settings
// provider_order); a provider with no key is skipped and the answer says which.

import { BraveProvider } from "./brave";
import { ExaProvider } from "./exa";
import { MockSearchProvider } from "./mock";
import type { ProviderId, SearchProvider } from "../types";

export const KNOWN_PROVIDERS: readonly ProviderId[] = ["brave", "exa", "mock"];
const DEFAULT_ORDER: readonly ProviderId[] = ["brave", "exa"];

type Env = Record<string, string | undefined>;

function make(id: ProviderId, env: Env, fetchFn?: typeof fetch): SearchProvider {
  if (id === "brave") return new BraveProvider({ apiKey: env.BRAVE_SEARCH_API_KEY ?? "", fetchFn });
  if (id === "exa") return new ExaProvider({ apiKey: env.EXA_API_KEY ?? "", fetchFn });
  return new MockSearchProvider();
}

export function resolveProviders(order: readonly string[], env: Env = process.env, fetchFn?: typeof fetch): { providers: SearchProvider[]; notes: string[] } {
  const notes: string[] = [];
  const wanted = (order.length ? order : DEFAULT_ORDER).filter((id): id is ProviderId => (KNOWN_PROVIDERS as readonly string[]).includes(id));
  const providers: SearchProvider[] = [];
  for (const id of wanted) {
    const p = make(id, env, fetchFn);
    if (p.isConfigured()) providers.push(p);
    else if (order.length) notes.push(`${id} is not configured on this server, so it was skipped.`);
  }
  if (providers.length === 0) {
    notes.unshift("No search provider is configured on this server, so these are mock results, not a live search.");
    providers.push(new MockSearchProvider());
  }
  return { providers, notes };
}
