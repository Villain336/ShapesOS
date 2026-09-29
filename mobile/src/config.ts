// Marketr mobile — backend configuration.
//
// The app talks to the SAME Next.js backend as the web app. No separate
// mobile API surface, no separate agent logic: every screen below hits the
// existing routes (/api/agents/chat SSE, /api/autopilot/…, /api/missions).
//
// Base URL resolution order:
//   1. EXPO_PUBLIC_API_BASE_URL (build-time env, `eas`/local)
//   2. app.json extra.apiBaseUrl
//   3. http://localhost:3000 (dev)
//
// NOTE for physical devices: the dev server's localhost is the PHONE's
// localhost. Point the base URL at the dev machine's LAN IP
// (e.g. http://192.168.1.10:3000) when running on hardware.

import Constants from "expo-constants";

const FALLBACK_BASE_URL = "http://localhost:3000";

export function resolveApiBaseUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_BASE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  const fromExtra = (Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined)
    ?.apiBaseUrl?.trim();
  if (fromExtra) return fromExtra.replace(/\/+$/, "");
  return FALLBACK_BASE_URL;
}

export const API_BASE_URL = resolveApiBaseUrl();
