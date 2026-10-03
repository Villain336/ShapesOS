// ShapesOS — navigation config completeness.
// Run: npx tsx --test lib/nav/__tests__/nav.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  activeNavHref,
  allNavItems,
  NAV_GROUPS,
  NAV_HOTKEYS,
  navCommands,
  pathMatches,
} from "../config";
import { capIdleSection, rankCommands, type CommandItem } from "../../../components/command-bar/lib";

const ROOT = path.resolve(__dirname, "../../..");

function pageFileFor(href: string): string {
  return path.join(ROOT, "app", ...href.split("/").filter(Boolean), "page.tsx");
}

describe("nav config", () => {
  it("every nav item resolves to a real app/ page", () => {
    for (const item of allNavItems()) {
      const file = pageFileFor(item.href);
      assert.ok(existsSync(file), `${item.label} → ${item.href} has no ${path.relative(ROOT, file)}`);
    }
  });

  it("has no duplicate destinations or labels", () => {
    const hrefs = allNavItems().map((i) => i.href);
    assert.equal(new Set(hrefs).size, hrefs.length, "duplicate href");
    const labels = allNavItems().map((i) => i.label.toLowerCase());
    assert.equal(new Set(labels).size, labels.length, "duplicate label");
  });

  it("groups into Grow / Design / Operate / Agents, then Settings and Billing", () => {
    assert.deepEqual(
      NAV_GROUPS.map((g) => g.id),
      ["home", "grow", "design", "operate", "agents", "account"],
    );
    assert.deepEqual(
      NAV_GROUPS.filter((g) => g.title).map((g) => g.title),
      ["Grow", "Design", "Operate", "Agents"],
    );
    const account = NAV_GROUPS.find((g) => g.id === "account")!;
    assert.deepEqual(account.items.map((i) => i.href), ["/dashboard/settings", "/dashboard/billing"]);
  });

  it("links the previously orphaned areas", () => {
    const hrefs = new Set(allNavItems().map((i) => i.href));
    for (const href of [
      "/dashboard/projects",
      "/dashboard/nurture",
      "/dashboard/prospects",
      "/dashboard/voice",
      "/dashboard/insurance",
      "/dashboard/billing",
      "/dashboard/runs",
      "/dashboard/approvals",
    ]) {
      assert.ok(hrefs.has(href), `${href} missing from nav`);
    }
  });

  it("labels are sentence case", () => {
    for (const item of allNavItems()) {
      // First letter upper (or an acronym like CRM/CAD); later words lower
      // unless they are acronyms.
      const words = item.label.split(/\s+/);
      for (const w of words.slice(1)) {
        assert.ok(w === w.toLowerCase() || w === w.toUpperCase(), `"${item.label}" is not sentence case`);
      }
    }
  });

  it("Approvals carries the needs-you badge slot", () => {
    const approvals = allNavItems().find((i) => i.href === "/dashboard/approvals")!;
    assert.equal(approvals.badge, "needs-you");
  });
});

describe("activeNavHref", () => {
  it("Overview matches only /dashboard exactly", () => {
    assert.equal(activeNavHref("/dashboard"), "/dashboard");
    assert.equal(activeNavHref("/dashboard/unknown-area"), null);
  });

  it("picks the owning item for nested routes", () => {
    assert.equal(activeNavHref("/dashboard/settings/members"), "/dashboard/settings");
    assert.equal(activeNavHref("/dashboard/projects/abc/keywords"), "/dashboard/projects");
    assert.equal(activeNavHref("/dashboard/voice/scripts"), "/dashboard/voice");
    assert.equal(activeNavHref("/dashboard/runs/run_1"), "/dashboard/runs");
  });

  it("uses activePrefix when the landing page differs", () => {
    assert.equal(activeNavHref("/dashboard/intelligence/competitors"), "/dashboard/intelligence/radar");
  });

  it("respects segment boundaries", () => {
    assert.equal(pathMatches("/dashboard/mail", "/dashboard/media"), false);
    assert.equal(pathMatches("/dashboard/mailbox", "/dashboard/mail"), false);
    assert.equal(pathMatches("/dashboard/mail/eddm", "/dashboard/mail"), true);
  });
});

describe("⌘K Go section", () => {
  it("covers every nav destination exactly once", () => {
    const goHrefs = navCommands().map((c) => c.href);
    assert.deepEqual(goHrefs, allNavItems().map((i) => i.href));
    for (const c of navCommands()) {
      assert.equal(c.section, "go");
      assert.equal(c.id, `go:${c.href}`);
    }
  });

  it("CommandBar builds its Go list from the nav config", () => {
    const src = readFileSync(path.join(ROOT, "components/command-bar/CommandBar.tsx"), "utf8");
    assert.match(src, /const GO_ITEMS: UICommand\[\] = navCommands\(\);/);
  });

  it("keeps the original ⌥1–⌥6 hotkeys on real destinations", () => {
    const byHref = new Map(navCommands().map((c) => [c.href, c]));
    for (const [href, key] of Object.entries(NAV_HOTKEYS)) {
      assert.equal(byHref.get(href)?.hotkey, key, `${href} lost ${key}`);
    }
    const keys = Object.values(NAV_HOTKEYS);
    assert.equal(new Set(keys).size, keys.length);
  });

  it("every destination is findable by typing its label", () => {
    const items = navCommands() as unknown as CommandItem[];
    for (const c of navCommands()) {
      const ranked = capIdleSection(rankCommands(items, c.title, {}, 0), c.title, "go", 8);
      assert.ok(
        ranked.some((r) => r.id === c.id),
        `typing "${c.title}" does not find ${c.href}`,
      );
    }
  });

  it("idle palette caps the Go section but searching does not", () => {
    const items = navCommands() as unknown as CommandItem[];
    const idle = capIdleSection(rankCommands(items, "", {}, 0), "", "go", 8);
    assert.equal(idle.length, 8);
    const searched = capIdleSection(rankCommands(items, "a", {}, 0), "a", "go", 8);
    assert.ok(searched.length > 8);
  });
});
