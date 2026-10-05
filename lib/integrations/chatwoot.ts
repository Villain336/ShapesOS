// Marketr — Phase 12 "embeds": Chatwoot live-chat widget (MIT core).
// BYO pattern: CHATWOOT_BASE_URL + CHATWOOT_WEBSITE_TOKEN on the host.
// The widget is OFF by default even when credentials exist — the operator
// must explicitly opt in with CHATWOOT_WIDGET_ENABLED=true. Key/token
// material is never displayed; only configured/on/off status.

import { sidecarEnv } from "./sidecar-tenancy";
export const CHATWOOT_BASE_URL_ENV = "CHATWOOT_BASE_URL";
export const CHATWOOT_WEBSITE_TOKEN_ENV = "CHATWOOT_WEBSITE_TOKEN";
export const CHATWOOT_WIDGET_ENABLED_ENV = "CHATWOOT_WIDGET_ENABLED";

export interface ChatwootStatus {
  /** Credentials present (URL + website token). */
  configured: boolean;
  /** Explicit operator opt-in. Off by default. */
  enabled: boolean;
  /** True only when both configured and enabled — the only state that loads the widget. */
  active: boolean;
  name: string;
}

export function chatwootStatus(env: Record<string, string | undefined> = sidecarEnv("chatwoot")): ChatwootStatus {
  const configured = !!(
    env[CHATWOOT_BASE_URL_ENV] && env[CHATWOOT_WEBSITE_TOKEN_ENV]
  );
  const enabled = env[CHATWOOT_WIDGET_ENABLED_ENV] === "true";
  return {
    configured,
    enabled,
    active: configured && enabled,
    name: "chatwoot",
  };
}

/** Public widget config — safe to serialize to the client. */
export function chatwootWidgetConfig(env: Record<string, string | undefined> = sidecarEnv("chatwoot")): {
  baseUrl: string;
  websiteToken: string;
} | null {
  const status = chatwootStatus(env);
  if (!status.active) return null;
  const baseUrl = env[CHATWOOT_BASE_URL_ENV]!;
  const websiteToken = env[CHATWOOT_WEBSITE_TOKEN_ENV]!;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), websiteToken };
}
