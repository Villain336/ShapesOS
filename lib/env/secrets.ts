// ShapesOS — fail-closed secret + fake-provider policy (Phase 1, H4).
//
// Mirrors lib/authority/outreach/sequences.ts approvalSecret(): in
// production an unset signing/encryption secret THROWS instead of falling
// back to a literal that ships in the repo (a known fallback lets anyone
// forge webhooks, unsubscribe tokens or approval receipts). Dev and tests
// keep a loud, documented fallback so local work needs no setup.
//
// Fake providers (messaging, calls, CallRail, mail webhooks) simulate
// delivery and accept a shared-secret signature. They are refused when
// NODE_ENV=production unless the operator opts in with ALLOW_FAKE_PROVIDERS=1
// (demo installs) — and even then their secret must be set explicitly.

export class MissingSecretError extends Error {
  readonly envVar: string;
  constructor(envVar: string) {
    super(`${envVar} is not set — refusing to fall back to a built-in secret in production.`);
    this.name = "MissingSecretError";
    this.envVar = envVar;
  }
}

export class FakeProviderRefusedError extends Error {
  readonly provider: string;
  constructor(provider: string) {
    super(
      `The fake ${provider} provider is disabled in production. Configure a real provider, ` +
        `or set ALLOW_FAKE_PROVIDERS=1 for a demo install.`,
    );
    this.name = "FakeProviderRefusedError";
    this.provider = provider;
  }
}

export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "production";
}

const warned = new Set<string>();

/**
 * Read a secret. Unset/blank → throws MissingSecretError in production;
 * elsewhere returns `devFallback` (warning once per variable).
 */
export function requireSecret(
  envVar: string,
  devFallback: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = (env[envVar] ?? "").trim();
  if (value) return value;
  if (isProduction(env)) throw new MissingSecretError(envVar);
  if (!warned.has(envVar) && env.NODE_ENV !== "test") {
    warned.add(envVar);
    // eslint-disable-next-line no-console
    console.warn(`[secrets] WARNING: ${envVar} unset — using an insecure dev fallback. Set it before any production use.`);
  }
  return devFallback;
}

/** True when fake providers may run: always outside production, opt-in inside. */
export function fakeProvidersAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isProduction(env) || (env.ALLOW_FAKE_PROVIDERS ?? "").trim() === "1";
}

/** Throw FakeProviderRefusedError when a fake provider would run in production. */
export function assertFakeProviderAllowed(provider: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!fakeProvidersAllowed(env)) throw new FakeProviderRefusedError(provider);
}
