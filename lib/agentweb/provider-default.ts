// ShapesOS — Phase 21A (WS=agentweb): which BrowserProvider the tools use.
//
// AGENTWEB_PROVIDER = "server" (default: Playwright Chromium) or "server-http"
// (no JavaScript, no browser binary). The Desktop live-tab provider joins here
// when the Desktop browser lands (lib/agentweb/provider.ts).

import { assertSafeUrl } from "@/lib/safe-url";
import { HttpBrowserProvider } from "./provider-http";
import { PlaywrightProvider } from "./provider-server";
import { getBrowserProvider, ProviderUnavailableError, registerBrowserProvider, type BrowserProvider } from "./provider";

const checkUrl = (url: string) => assertSafeUrl(url);

registerBrowserProvider("server", () => new PlaywrightProvider({ checkUrl }));
registerBrowserProvider("server-http", () => new HttpBrowserProvider({ checkUrl }));

export function defaultProviderId(env: Record<string, string | undefined> = process.env): "server" | "server-http" {
  return (env.AGENTWEB_PROVIDER ?? "").trim().toLowerCase() === "server-http" ? "server-http" : "server";
}

export async function defaultProvider(): Promise<BrowserProvider> {
  const provider = getBrowserProvider(defaultProviderId());
  const ok = await provider.available();
  if (ok.ok) return provider;
  // Fall back to the browserless provider rather than failing the task, and say so in the session's provider id.
  const http = getBrowserProvider("server-http");
  if ((await http.available()).ok) return http;
  throw new ProviderUnavailableError(provider.id, ok.reason);
}
