// ShapesOS — Phase 15.4 (zernio): which Zernio a call reaches.
//
//   live  ZERNIO_API_KEY is set — the platform key, LIVE / pre-added
//         (documented in .env.example). ZERNIO_BASE_URL overrides the base
//         URL (default https://zernio.com/api).
//   mock  no key, and fakes are allowed (dev, tests, or a demo install with
//         ALLOW_FAKE_PROVIDERS=1): the labelled FAKE Zernio (lib/zernio/fake.ts),
//         every result flagged mock and every invented name "(MOCK)".
//   off   no key in production: every Zernio surface says "Zernio is not
//         connected" — nothing is faked (lib/connectors/m21/no-fakes.ts rule).

import { fakeProvidersAllowed } from "@/lib/env/secrets";
import { ZernioClient } from "./client";
import { FakeZernio, fakeResolve } from "./fake";
import { ZERNIO_DEFAULT_BASE_URL } from "./spec";

export type ZernioMode = "live" | "mock" | "off";

export function zernioApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const k = (env.ZERNIO_API_KEY ?? "").trim();
  return k ? k : null;
}

export function zernioBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const u = (env.ZERNIO_BASE_URL ?? "").trim();
  return u ? u.replace(/\/+$/, "") : ZERNIO_DEFAULT_BASE_URL;
}

export function zernioMode(env: NodeJS.ProcessEnv = process.env): ZernioMode {
  if (zernioApiKey(env)) return "live";
  return fakeProvidersAllowed(env) ? "mock" : "off";
}

export const ZERNIO_NOT_CONNECTED_MESSAGE =
  "Zernio is not connected. Set ZERNIO_API_KEY (the platform key) to turn on ads and social publishing through Zernio (mock data is never used in production).";

export class ZernioNotConfiguredError extends Error {
  readonly code = "not_connected";
  constructor() {
    super(ZERNIO_NOT_CONNECTED_MESSAGE);
    this.name = "NotConfiguredError";
  }
}

let fakeSingleton: FakeZernio | null = null;
let defaultFakeClient: ZernioClient | null = null;
let override: ZernioClient | null = null;

/** The process-wide labelled fake used in mock mode. */
export function getFakeZernio(): FakeZernio {
  fakeSingleton ??= new FakeZernio();
  return fakeSingleton;
}

/** Tests only: force the client (e.g. a client on a fresh FakeZernio); null clears. */
export function setZernioClientForTests(client: ZernioClient | null): void {
  override = client;
}

/** A client on a given fake (tests). */
export function clientForFake(fake: FakeZernio, opts: { sleep?: (ms: number) => Promise<void> } = {}): ZernioClient {
  return new ZernioClient({ apiKey: "fake-zernio-key", mode: "mock", fetchImpl: fake.fetch, resolve: fakeResolve, sleep: opts.sleep ?? (async () => {}) });
}

/** The Zernio client for this process, or a NotConfiguredError when Zernio is off. */
export function getZernioClient(env: NodeJS.ProcessEnv = process.env): ZernioClient {
  if (override) return override;
  const mode = zernioMode(env);
  if (mode === "live") return new ZernioClient({ apiKey: zernioApiKey(env)!, baseUrl: zernioBaseUrl(env), mode: "live" });
  if (mode === "mock") {
    defaultFakeClient ??= clientForFake(getFakeZernio());
    return defaultFakeClient;
  }
  throw new ZernioNotConfiguredError();
}

/** True for the process-wide mock-mode client (dev / demo), not a test's own fake. */
export function isDefaultFakeClient(client: ZernioClient): boolean {
  return client === defaultFakeClient;
}

/** The mode a client stands for (an override client reports its own). */
export function activeZernioMode(env: NodeJS.ProcessEnv = process.env): ZernioMode {
  if (override) return override.mode;
  return zernioMode(env);
}
