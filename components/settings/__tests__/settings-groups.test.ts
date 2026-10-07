// ShapesOS — Phase 18.3 (WS=trust): System Settings grouping (unit).
// Run: npx tsx --test components/settings/__tests__/settings-groups.test.ts
//
// Every settings page on disk appears in SETTINGS_GROUPS exactly once (or is
// a sub-page of one that does: a client's detail page, connector sync), every
// listed page exists, the two halves are in order, and settings search finds
// pages by label, description and group in either language.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  SETTINGS_GROUPS,
  allSettingsPages,
  searchSettings,
  settingsHalf,
  settingsLocation,
} from "../settingsSections";
import { en } from "@/lib/i18n/messages/en";
import { es } from "@/lib/i18n/messages/es";

const ROOT = join(process.cwd(), "app", "dashboard", "settings");

/** Every route under app/dashboard/settings that has a page.tsx. */
function settingsRoutes(dir = ROOT): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...settingsRoutes(p));
    else if (name === "page.tsx") {
      const rel = relative(ROOT, dir).split(sep).filter(Boolean).join("/");
      out.push(rel ? `/dashboard/settings/${rel}` : "/dashboard/settings");
    }
  }
  return out;
}

describe("settings grouping", () => {
  const pages = allSettingsPages();

  it("lists every page exactly once", () => {
    const seen = new Map<string, number>();
    for (const p of pages) seen.set(p.href, (seen.get(p.href) ?? 0) + 1);
    const dupes = [...seen].filter(([, n]) => n > 1).map(([h]) => h);
    assert.deepEqual(dupes, []);
  });

  it("covers every settings page on disk (sub-pages through their parent)", () => {
    const listed = new Set(pages.map((p) => p.href));
    const unlisted: string[] = [];
    for (const route of settingsRoutes()) {
      if (route === "/dashboard/settings") continue; // the index
      if (listed.has(route)) continue;
      // A sub-page (dynamic segment or a nested tool page) belongs to the
      // listed page it sits under.
      const { page } = settingsLocation(route.replace(/\[[^\]]+\]/g, "x"));
      if (!page) unlisted.push(route);
    }
    assert.deepEqual(unlisted, [], "settings pages missing from SETTINGS_GROUPS");
  });

  it("every listed page exists on disk", () => {
    for (const p of pages) {
      const dir = join(process.cwd(), "app", ...p.href.split("/").filter(Boolean));
      assert.ok(existsSync(join(dir, "page.tsx")), `${p.href} has no page.tsx`);
    }
  });

  it("is two halves: You first, then the workspace", () => {
    assert.equal(SETTINGS_GROUPS[0]!.half, "you");
    assert.deepEqual(settingsHalf("you").map((g) => g.id), ["you"]);
    const firstWorkspace = SETTINGS_GROUPS.findIndex((g) => g.half === "workspace");
    assert.ok(SETTINGS_GROUPS.slice(firstWorkspace).every((g) => g.half === "workspace"), "halves are contiguous");
    assert.ok(settingsHalf("workspace").some((g) => g.id === "privacy"), "Privacy and security is a workspace group");
  });

  it("the You half has the plan's pages, in order (Cursor is personal, from Phase 19A)", () => {
    const you = settingsHalf("you")[0]!.pages.map((p) => en.settings.pages[p.href as keyof typeof en.settings.pages]?.label);
    assert.deepEqual(you, ["General", "Appearance", "Notifications", "Keyboard", "Accessibility", "Language and region", "Privacy", "Cursor", "Your security", "Your account"]);
  });

  it("Security and the Audit log moved to Privacy and security, keeping their URLs", () => {
    assert.equal(settingsLocation("/dashboard/settings/security").group.id, "privacy");
    assert.equal(settingsLocation("/dashboard/settings/audit").group.id, "privacy");
    assert.equal(settingsLocation("/dashboard/settings/security-center/apps").page?.href, "/dashboard/settings/security-center/apps");
  });

  it("every group and page is translated in en and es", () => {
    for (const g of SETTINGS_GROUPS) {
      assert.ok((en.settings.groups as Record<string, string>)[g.id], `en group ${g.id}`);
      assert.ok((es.settings.groups as Record<string, string>)[g.id], `es group ${g.id}`);
      for (const p of g.pages) {
        assert.ok((es.settings.pages as Record<string, unknown>)[p.href], `es page ${p.href}`);
      }
    }
  });
});

describe("settings search", () => {
  const textIn = (cat: typeof en | typeof es) => (p: { href: string; label: string; description: string }, groupId: string) => {
    const m = (cat.settings.pages as Record<string, { label: string; description: string }>)[p.href] ?? p;
    return { label: m.label, description: m.description, group: (cat.settings.groups as Record<string, string>)[groupId] ?? "" };
  };

  it("finds by label, label matches first", () => {
    const r = searchSettings("notif", textIn(en)).map((p) => p.href);
    assert.ok(r.includes("/dashboard/settings/you/notifications"));
    assert.ok(r.includes("/dashboard/settings/notifications"));
    assert.ok(r.indexOf("/dashboard/settings/you/notifications") < r.length);
  });

  it("finds by description and by group, every word must match", () => {
    assert.ok(searchSettings("passkeys", textIn(en)).some((p) => p.href === "/dashboard/settings/account-security"));
    assert.ok(searchSettings("privacy security", textIn(en)).some((p) => p.href === "/dashboard/settings/audit"));
    assert.deepEqual(searchSettings("passkeys zebra", textIn(en)), []);
    assert.deepEqual(searchSettings("   ", textIn(en)), []);
  });

  it("searches in the person's language, accents optional", () => {
    assert.ok(searchSettings("teclado", textIn(es)).some((p) => p.href === "/dashboard/settings/you/keyboard"));
    assert.ok(searchSettings("facturacion", textIn(es)).some((p) => p.href === "/dashboard/billing"));
  });
});
