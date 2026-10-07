// Phase 19A (WS=server): registry coverage — every nav destination and every
// kit primary action is addressable by the cursor (data-cursor-id), ids are
// unique and stable, and the page publishes window.__shapesUiMap().

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { allNavItems } from "@/lib/nav/config";
import { KIT_NON_PRIMARY, KIT_PRIMARY_ACTIONS, SHELL_TARGETS, cursorSlug, cursorTarget, navCursorId } from "../registry";
import { navCursorTargets } from "../registry-nav";

const ROOT = process.cwd();
const src = (f: string) => readFileSync(join(ROOT, f), "utf8");

describe("nav destinations", () => {
  it("every nav item has one unique nav:<href> id", () => {
    const targets = navCursorTargets();
    const hrefs = new Set(allNavItems().map((i) => i.href));
    assert.equal(targets.length, hrefs.size);
    assert.equal(new Set(targets.map((t) => t.id)).size, targets.length);
    for (const h of hrefs) assert.ok(targets.some((t) => t.id === navCursorId(h)), h);
    console.log(`# nav destinations addressable: ${targets.length}/${hrefs.size}`);
  });
  it("the sidebar spreads the nav id on BOTH row forms (rail and expanded)", () => {
    const s = src("components/AppSidebar.tsx");
    const n = s.split("cursorTarget(navCursorId(item.href), item.label").length - 1;
    assert.equal(n, 2);
  });
});

describe("shell", () => {
  it("top bar, Needs-you, ⌘K, New task and the nav landmark are targets", () => {
    const top = src("components/AppTopBar.tsx");
    const side = src("components/AppSidebar.tsx");
    assert.ok(top.includes("SHELL_TARGETS.topbar"));
    assert.ok(top.includes("SHELL_TARGETS.needsYou"));
    assert.ok(side.includes("SHELL_TARGETS.commandBar"));
    assert.ok(side.includes("SHELL_TARGETS.newTask"));
    assert.ok(side.includes("SHELL_TARGETS.sidebar"));
    assert.equal(new Set(Object.values(SHELL_TARGETS)).size, Object.values(SHELL_TARGETS).length);
  });
  it("the dashboard layout mounts the UI map publisher", () => {
    assert.ok(src("app/dashboard/layout.tsx").includes("<CursorUiMap />"));
    assert.ok(src("components/cursor/CursorUiMap.tsx").includes("window.__shapesUiMap = fn"));
  });
});

describe("kit primary actions", () => {
  let total = 0;
  for (const k of KIT_PRIMARY_ACTIONS) {
    it(`${k.component} wires ${k.ids.join(", ")}`, () => {
      const s = src(k.file);
      assert.ok(s.includes("@/lib/cursor/registry"), `${k.file} imports the registry`);
      for (const id of k.ids) assert.ok(s.includes(id), `${k.file} carries ${id}`);
      total += k.ids.length;
    });
  }
  it("covers every kit file that renders a button or link (components/aos), derived from the files", () => {
    const kitFiles = readdirSync(join(ROOT, "components/aos"))
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => `components/aos/${f}`);
    const pressable = kitFiles.filter((f) => /<button\b|<Link\b|<a\s/.test(src(f)));
    const wired = new Set(KIT_PRIMARY_ACTIONS.map((k) => k.file));
    const unaccounted = pressable.filter((f) => !wired.has(f) && !KIT_NON_PRIMARY[f]);
    assert.deepEqual(unaccounted, [], `kit files with a button/link that are neither cursor targets nor listed as non-primary: ${unaccounted.join(", ")}`);
    // Neither list names a file that does not exist or has nothing to press.
    for (const f of [...wired, ...Object.keys(KIT_NON_PRIMARY)]) assert.ok(pressable.includes(f), `${f} renders a button or link`);
    for (const f of Object.keys(KIT_NON_PRIMARY)) assert.ok(!wired.has(f), `${f} is in one list only`);
    const primary = pressable.filter((f) => wired.has(f)).length;
    console.log(`# kit files with something to press: ${pressable.length} — ${primary} wired as cursor targets (${total} ids), ${pressable.length - primary} non-primary by design`);
  });
  it("the Approvals inbox's cards carry approve / deny per item", () => {
    const s = src("components/aos/ApprovalCard.tsx");
    assert.ok(s.includes("approval:${cursorKey}:approve"));
    assert.ok(s.includes("approval:${cursorKey}:deny"));
    assert.ok(src("app/dashboard/approvals/ApprovalsInbox.tsx").includes("id={cardId(item)}"));
  });
});

describe("helpers", () => {
  it("cursorTarget sets id, label and role", () => {
    assert.deepEqual(cursorTarget("kit:x", "  Run   Researcher "), { "data-cursor-id": "kit:x", "data-cursor-label": "Run Researcher", "data-cursor-role": "button" });
  });
  it("slugs are stable ascii", () => {
    assert.equal(cursorSlug("Approve and send"), "approve-and-send");
    assert.equal(cursorSlug("Revisión rápida"), "revision-rapida");
    assert.equal(cursorSlug("!!!"), "action");
  });
});
