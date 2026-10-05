// ShapesOS mobile — Expo app config (replaces the static app.json).
//
// Everything that differs per build comes from the environment, so EAS
// profiles (eas.json) and self-hosters set it without editing code:
//
//   SHAPESOS_IOS_BUNDLE_ID       iOS bundle identifier   (placeholder below)
//   SHAPESOS_ANDROID_PACKAGE     Android application id  (placeholder below)
//   EAS_PROJECT_ID               EAS project id — needed for Expo push tokens
//   SHAPESOS_API_BASE_URL        default server baked into the build
//                                (EXPO_PUBLIC_API_BASE_URL wins at runtime;
//                                the in-app Server setting wins over both)
//   SHAPESOS_APP_VARIANT         "development" | "preview" | "production":
//                                non-production builds get a suffixed id and
//                                name so they install next to the store app
//
// The placeholders are NOT real identifiers: replace them with your own
// reverse-DNS ids before submitting to the App Store / Play Store. No signing
// credentials live in this repo (EAS manages them remotely).

import type { ConfigContext, ExpoConfig } from "expo/config";

// Native config colors. The Expo config loader can't import app TypeScript,
// so these mirror src/theme.ts (Agentic OS tokens); __tests__/app-config.test.ts
// fails if they drift.
export const NATIVE_COLORS = { canvas: "#F3F3F1", ink: "#000000" } as const;
const color = NATIVE_COLORS;

export const PLACEHOLDER_IOS_BUNDLE_ID = "com.example.shapesos";
export const PLACEHOLDER_ANDROID_PACKAGE = "com.example.shapesos";

type Variant = "development" | "preview" | "production";

function variantOf(env: NodeJS.ProcessEnv): Variant {
  const v = (env.SHAPESOS_APP_VARIANT ?? "").trim();
  return v === "development" || v === "preview" ? v : "production";
}

export function buildConfig(config: Partial<ExpoConfig>, env: NodeJS.ProcessEnv = process.env): ExpoConfig {
  const variant = variantOf(env);
  const suffix = variant === "production" ? "" : `.${variant === "development" ? "dev" : "preview"}`;
  const nameSuffix = variant === "production" ? "" : variant === "development" ? " (Dev)" : " (Preview)";
  const iosId = (env.SHAPESOS_IOS_BUNDLE_ID ?? "").trim() || PLACEHOLDER_IOS_BUNDLE_ID;
  const androidId = (env.SHAPESOS_ANDROID_PACKAGE ?? "").trim() || PLACEHOLDER_ANDROID_PACKAGE;
  const projectId = (env.EAS_PROJECT_ID ?? "").trim() || undefined;

  return {
    ...config,
    name: `ShapesOS${nameSuffix}`,
    slug: "shapesos",
    scheme: "shapesos",
    version: "0.2.0",
    orientation: "portrait",
    userInterfaceStyle: "light",
    backgroundColor: color.canvas,
    ios: {
      bundleIdentifier: `${iosId}${suffix}`,
      supportsTablet: true,
      infoPlist: { ITSAppUsesNonExemptEncryption: false },
    },
    android: {
      package: `${androidId}${suffix}`,
      adaptiveIcon: { backgroundColor: color.ink },
    },
    plugins: [
      "expo-secure-store",
      ["expo-notifications", { color: color.ink, defaultChannel: "default" }],
      // Splash: solid black (the brand's night surface); the app's first
      // screen then shows the "ShapesOS" wordmark while the session restores.
      // Add `image` once brand artwork exists (no binary assets are checked in).
      ["expo-splash-screen", { backgroundColor: color.ink, resizeMode: "contain" }],
    ],
    extra: {
      apiBaseUrl: (env.SHAPESOS_API_BASE_URL ?? "").trim() || "http://localhost:3000",
      variant,
      ...(projectId ? { eas: { projectId } } : {}),
    },
    ...(projectId ? { updates: { url: `https://u.expo.dev/${projectId}` }, runtimeVersion: { policy: "appVersion" } } : {}),
  };
}

export default ({ config }: ConfigContext): ExpoConfig => buildConfig(config);
