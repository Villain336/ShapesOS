// ShapesOS — Phase 11 (conncore): no fake success from built-in connectors
// in production.
//
// Most built-in adapters fall back to a LABELLED mock (mock: true, "(MOCK)"
// labels) when the connection has no credential. That is right for dev,
// tests and demo installs, and wrong in production: a customer whose GA4
// token is missing must see "GA4 is not connected", never a plausible
// traffic report. resolveAdapter() wraps every built-in adapter with this
// guard, so the rule holds for every caller (agent loop, import engine,
// analytics overview, health probe) without each adapter repeating it:
//
//   - production (NODE_ENV=production) without ALLOW_FAKE_PROVIDERS=1 and no
//     credential → { ok:false, errorCode:"not_connected" } before the
//     adapter runs;
//   - any result still flagged mock:true in production (e.g. a demo
//     WordPress config) is replaced by the same not_connected failure.
//
// Dev/test keep the labelled mocks. The enumeration test
// (lib/connectors/__tests__/no-fakes.test.ts) walks the whole registry.

import { fakeProvidersAllowed } from "@/lib/env/secrets";
import type { ConnectorAdapter, InvokeResult } from "./types";

export function notConnectedResult(displayName: string): InvokeResult {
  return {
    ok: false,
    mock: false,
    errorCode: "not_connected",
    error: `${displayName} is not connected. Connect it in Settings → Connectors (mock data is never used in production).`,
  };
}

/** Wrap an adapter's invoke() with the production no-fakes rule (mutates and returns it). */
export function withNoFakesGuard<T extends ConnectorAdapter>(adapter: T): T {
  const original = adapter.invoke.bind(adapter);
  const guarded: ConnectorAdapter["invoke"] = async (tool, args, credential, ctx) => {
    const allowFakes = fakeProvidersAllowed();
    if (!allowFakes && adapter.authType !== "none" && !credential) {
      return notConnectedResult(adapter.displayName);
    }
    const result = await original(tool, args, credential, ctx);
    if (!allowFakes && result.mock === true) return notConnectedResult(adapter.displayName);
    return result;
  };
  Object.defineProperty(adapter, "invoke", { value: guarded, configurable: true, writable: true });
  return adapter;
}
