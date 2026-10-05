// ShapesOS mobile — Expo app config + EAS profiles.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NATIVE_COLORS, PLACEHOLDER_ANDROID_PACKAGE, PLACEHOLDER_IOS_BUNDLE_ID, buildConfig } from "../app.config";
import { color } from "../src/theme";

const ROOT = join(__dirname, "..");

describe("app.config.ts", () => {
  it("is branded ShapesOS with placeholder ids by default", () => {
    const c = buildConfig({}, {} as NodeJS.ProcessEnv);
    expect(c.name).toBe("ShapesOS");
    expect(c.slug).toBe("shapesos");
    expect(c.ios?.bundleIdentifier).toBe(PLACEHOLDER_IOS_BUNDLE_ID);
    expect(c.android?.package).toBe(PLACEHOLDER_ANDROID_PACKAGE);
    expect(c.extra?.apiBaseUrl).toBe("http://localhost:3000");
    expect(c.extra?.eas).toBeUndefined();
    expect(JSON.stringify(c.plugins)).toContain("expo-notifications");
  });

  it("takes ids, server and EAS project from the environment; non-production builds get suffixes", () => {
    const c = buildConfig({}, {
      SHAPESOS_IOS_BUNDLE_ID: "com.acme.shapes",
      SHAPESOS_ANDROID_PACKAGE: "com.acme.shapes",
      SHAPESOS_API_BASE_URL: "https://shapes.acme.com",
      EAS_PROJECT_ID: "11111111-2222-3333-4444-555555555555",
      SHAPESOS_APP_VARIANT: "preview",
    } as unknown as NodeJS.ProcessEnv);
    expect(c.name).toBe("ShapesOS (Preview)");
    expect(c.ios?.bundleIdentifier).toBe("com.acme.shapes.preview");
    expect(c.android?.package).toBe("com.acme.shapes.preview");
    expect(c.extra?.apiBaseUrl).toBe("https://shapes.acme.com");
    expect(c.extra?.eas).toEqual({ projectId: "11111111-2222-3333-4444-555555555555" });
  });
});

describe("native colors", () => {
  it("mirror the theme tokens", () => {
    expect(NATIVE_COLORS.canvas).toBe(color.canvas);
    expect(NATIVE_COLORS.ink).toBe(color.ink);
  });
});

describe("eas.json", () => {
  const eas = JSON.parse(readFileSync(join(ROOT, "eas.json"), "utf8")) as {
    build: Record<string, { env?: Record<string, string>; developmentClient?: boolean; distribution?: string }>;
    submit: Record<string, unknown>;
  };
  it("has development, preview and production profiles", () => {
    expect(Object.keys(eas.build)).toEqual(expect.arrayContaining(["development", "preview", "production"]));
    expect(eas.build.development!.developmentClient).toBe(true);
    expect(eas.build.preview!.distribution).toBe("internal");
    for (const p of ["development", "preview", "production"]) {
      expect(eas.build[p]!.env?.SHAPESOS_APP_VARIANT).toBe(p);
      expect(eas.build[p]!.env?.EXPO_PUBLIC_API_BASE_URL).toBeTruthy();
    }
  });
  it("holds placeholders only — no credentials", () => {
    const raw = readFileSync(join(ROOT, "eas.json"), "utf8");
    expect(raw).not.toMatch(/-----BEGIN|AKIA|"password"|ExponentPushToken/);
    expect(raw).toContain("REPLACE_WITH_");
  });
});
