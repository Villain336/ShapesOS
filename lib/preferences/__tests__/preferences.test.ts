// ShapesOS — Phase 18.1 (WS=find): preference validation + shell classes (unit).
// Run: npx tsx --test lib/preferences/__tests__/preferences.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  coercePreferences,
  DEFAULT_PREFERENCES,
  isValidTimeZone,
  parseShortcut,
  PREFERENCE_KEYS,
  PREFERENCE_SCHEMAS,
  PreferencesPatchSchema,
  validatePreference,
} from "../schema";
import {
  colorScheme,
  decodeShellCookie,
  DEFAULT_SHELL,
  encodeShellCookie,
  shellClassNames,
  shellFrom,
} from "../shell";

describe("preference schemas", () => {
  it("every key has a schema and a default that passes it", () => {
    assert.deepEqual(Object.keys(DEFAULT_PREFERENCES).sort(), [...PREFERENCE_KEYS].sort());
    for (const k of PREFERENCE_KEYS) {
      const r = PREFERENCE_SCHEMAS[k].safeParse(DEFAULT_PREFERENCES[k]);
      assert.ok(r.success, `default for ${k} is valid`);
    }
  });

  it("accepts valid values and refuses invalid ones", () => {
    assert.deepEqual(validatePreference("theme", "dark"), { ok: true, value: "dark" });
    assert.equal(validatePreference("theme", "purple").ok, false);
    assert.equal(validatePreference("language", "es").ok, true);
    assert.equal(validatePreference("language", null).ok, true, "null = match the browser");
    assert.equal(validatePreference("language", "fr").ok, false, "only catalogued languages");
    assert.equal(validatePreference("fontScale", 125).ok, true);
    assert.equal(validatePreference("fontScale", 130).ok, false);
    assert.equal(validatePreference("density", "compact").ok, true);
    assert.equal(validatePreference("motion", "reduce").ok, true);
    assert.equal(validatePreference("contrast", "high").ok, true);
    assert.equal(validatePreference("hourCycle", "h23").ok, true);
    // @ts-expect-error unknown keys are refused at runtime too
    assert.equal(validatePreference("isAdmin", true).ok, false);
  });

  it("time zones must be real IANA zones", () => {
    assert.equal(isValidTimeZone("Europe/Madrid"), true);
    assert.equal(isValidTimeZone("America/Argentina/Buenos_Aires"), true);
    assert.equal(isValidTimeZone("UTC"), true);
    assert.equal(isValidTimeZone("Mars/Olympus_Mons"), false);
    assert.equal(isValidTimeZone("'; DROP TABLE x;--"), false);
    assert.equal(validatePreference("timeZone", "Asia/Tokyo").ok, true);
    assert.equal(validatePreference("timeZone", "Nope/Zone").ok, false);
  });

  it("notification channels are strict", () => {
    assert.equal(validatePreference("notifications", { inApp: true, push: false, mutedKinds: ["alert_fired"] }).ok, true);
    assert.equal(validatePreference("notifications", { inApp: true, push: false, mutedKinds: ["spam"] }).ok, false);
    assert.equal(validatePreference("notifications", { inApp: true, push: false, mutedKinds: [], extra: 1 }).ok, false);
  });

  it("placeholders are bounded objects", () => {
    assert.equal(validatePreference("desktop", { widgets: ["kpis"] }).ok, true);
    assert.equal(validatePreference("desktop", ["not", "an", "object"]).ok, false);
    assert.equal(validatePreference("voice", { blob: "x".repeat(5000) }).ok, false);
  });

  it("a patch is all-or-nothing and refuses unknown keys", () => {
    assert.equal(PreferencesPatchSchema.safeParse({ theme: "dark", density: "compact" }).success, true);
    assert.equal(PreferencesPatchSchema.safeParse({ theme: "dark", role: "owner" }).success, false);
    assert.equal(PreferencesPatchSchema.safeParse({ theme: "dark", density: "huge" }).success, false);
  });

  it("stored garbage falls back to defaults field by field", () => {
    const p = coercePreferences({ theme: "dark", density: "enormous", fontScale: 9000, language: "es" });
    assert.equal(p.theme, "dark");
    assert.equal(p.density, "comfortable");
    assert.equal(p.fontScale, 100);
    assert.equal(p.language, "es");
    assert.deepEqual(coercePreferences(null), DEFAULT_PREFERENCES);
  });
});

describe("shortcuts", () => {
  it("normalizes chords and sequences", () => {
    assert.deepEqual(parseShortcut("Shift+Mod+K"), { normalized: "mod+shift+k", kind: "chord" });
    assert.deepEqual(parseShortcut("ctrl+tab"), { normalized: "ctrl+tab", kind: "chord" });
    assert.deepEqual(parseShortcut("alt+1"), { normalized: "alt+1", kind: "chord" });
    assert.deepEqual(parseShortcut("g  i"), { normalized: "g i", kind: "sequence" });
    assert.deepEqual(parseShortcut("?"), { normalized: "?", kind: "chord" });
    assert.deepEqual(parseShortcut("escape"), { normalized: "escape", kind: "chord" });
  });

  it("refuses bindings that would fire while typing or can't be pressed", () => {
    for (const bad of ["k", "shift+k", "mod+", "+k", "mod+mod+k", "hyper+k", "g i o", "mod+superkey", "", 42]) {
      assert.equal(parseShortcut(bad), null, String(bad));
    }
  });

  it("the shortcut map validates ids, bindings and conflicts", () => {
    const ok = validatePreference("shortcuts", { "command_bar.open": "Mod+K", "nav.approvals": "g i" });
    assert.deepEqual(ok, { ok: true, value: { "command_bar.open": "mod+k", "nav.approvals": "g i" } });
    assert.equal(validatePreference("shortcuts", { "command_bar.open": "mod+k", "x.y": "MOD+k" }).ok, false, "two actions on one key");
    assert.equal(validatePreference("shortcuts", { "Bad Id": "mod+k" }).ok, false);
    assert.equal(validatePreference("shortcuts", { "a.b": "k" }).ok, false);
  });
});

describe("shell classes and cookie", () => {
  it("defaults paint nothing but theme-system", () => {
    assert.deepEqual(shellClassNames(DEFAULT_SHELL), ["theme-system"]);
    assert.equal(colorScheme(DEFAULT_SHELL), "light dark");
  });

  it("every preference maps to its class", () => {
    const classes = shellClassNames({ theme: "dark", contrast: "high", density: "compact", motion: "reduce", fontScale: 125, language: "es" });
    assert.deepEqual(classes, ["theme-dark", "dark", "contrast-high", "density-compact", "motion-reduce", "font-scale-125"]);
    assert.equal(colorScheme({ theme: "light" }), "light");
  });

  it("the cookie round-trips and tolerates junk", () => {
    const p = shellFrom({ ...DEFAULT_PREFERENCES, theme: "dark", fontScale: 150, language: "es", density: "compact" });
    assert.deepEqual(decodeShellCookie(encodeShellCookie(p)), p);
    assert.deepEqual(decodeShellCookie("t=evil;f=9000;l=xx;garbage"), DEFAULT_SHELL);
    assert.deepEqual(decodeShellCookie(undefined), DEFAULT_SHELL);
    assert.deepEqual(decodeShellCookie("x".repeat(500)), DEFAULT_SHELL);
  });
});
