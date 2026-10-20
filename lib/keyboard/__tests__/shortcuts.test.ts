// ShapesOS — Phase 18.1 (WS=desk): the shortcut registry.
// Run: npx tsx --test lib/keyboard/__tests__/shortcuts.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  SHORTCUTS,
  SHORTCUT_ID_RE,
  bindingsFor,
  canonicalCombo,
  comboKeycaps,
  comboMatches,
  findClashes,
  parseCombo,
  rebind,
  sanitizeOverrides,
  toStoredBinding,
} from "../shortcuts";
import { NAV_HOTKEYS } from "@/lib/nav/config";

const ROOT = path.resolve(__dirname, "../../..");
const ev = (key: string, mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }> = {}, code?: string) => ({
  key,
  code,
  metaKey: !!mods.meta,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
});

describe("the default map", () => {
  it("has no clashes", () => {
    assert.deepEqual(findClashes(bindingsFor({})), []);
  });

  it("ids are unique and follow WS=find's action-id rule", () => {
    const ids = SHORTCUTS.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, SHORTCUT_ID_RE);
  });

  it("every default parses and round-trips through the stored format", () => {
    for (const s of SHORTCUTS) {
      for (const c of [s.combo, ...(s.alternates ?? [])]) {
        const canonical = canonicalCombo(c);
        assert.equal(canonicalCombo(toStoredBinding(canonical)), canonical, `${s.id} ${c}`);
      }
    }
  });

  it("collects the shortcuts that already existed (⌘K, ⌘N, ⌘J, G I, ⌥M, ⌥P, ⌥1–⌥6)", () => {
    const combos = new Map(SHORTCUTS.map((s) => [s.id, canonicalCombo(s.combo)]));
    assert.equal(combos.get("palette.toggle"), "Mod+K");
    assert.equal(combos.get("task.new"), "Mod+N");
    assert.equal(combos.get("schedule.new"), "Mod+J");
    assert.equal(combos.get("go.approvals"), "G I");
    assert.equal(combos.get("palette.missions"), "Alt+M");
    assert.equal(combos.get("palette.playbooks"), "Alt+P");
    const digits = SHORTCUTS.filter((s) => s.id.startsWith("palette.go.")).map((s) => s.combo.replace("Alt+", "⌥"));
    assert.deepEqual(digits.sort(), Object.values(NAV_HOTKEYS).sort());
    // …and they really are the command bar's keys.
    const bar = readFileSync(path.join(ROOT, "components/command-bar/CommandBar.tsx"), "utf8");
    assert.match(bar, /key === "k"/);
    assert.match(bar, /key === "j"/);
    assert.match(bar, /key === "i" && prev\?\.key === "g"/);
    const composer = readFileSync(path.join(ROOT, "components/command-bar/NewTaskDialog.tsx"), "utf8");
    assert.match(composer, /e\.key\.toLowerCase\(\) === "n"/);
  });

  it("the desk's own shortcuts are there", () => {
    const ids = new Set(SHORTCUTS.map((s) => s.id));
    for (const id of ["switcher.open", "help.shortcuts", "control.open", "focus.toggle", "split.open", "split.swap", "split.close", "desktop.edit"]) {
      assert.ok(ids.has(id), id);
    }
  });
});

describe("rebinding", () => {
  it("refuses a clash with another live shortcut", () => {
    const r = rebind({}, "task.new", "Mod+K");
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /Open the command bar/);
    // Ctrl and Mod collide (the command bar accepts either).
    assert.equal(rebind({}, "task.new", "Ctrl+K").ok, false);
    // A sequence starting with a bound key clashes too.
    assert.equal(rebind({}, "help.shortcuts", "G").ok, false);
    // Split-view keys clash with global ones, not with the switcher's.
    assert.equal(rebind({}, "split.swap", "Alt+Shift+C").ok, false);
  });

  it("allows the same combo in scopes that are never live together", () => {
    // Alt+Shift+E edits the desktop (Home); split view is another page.
    assert.ok(rebind({}, "split.swap", "Alt+Shift+E").ok);
    // …but the command bar opens over every page, so its keys stay taken.
    assert.equal(rebind({}, "split.swap", "Alt+M").ok, false);
    assert.equal(rebind({}, "desktop.edit", "Alt+P").ok, false);
  });

  it("refuses reserved browser combos, bare navigation keys and fixed shortcuts", () => {
    assert.equal(rebind({}, "task.new", "Mod+W").ok, false);
    assert.equal(rebind({}, "task.new", "Ctrl+W").ok, false);
    assert.equal(rebind({}, "switcher.open", "Tab").ok, false);
    assert.equal(rebind({}, "switcher.open", "Escape").ok, false);
    assert.equal(rebind({}, "switcher.next", "Ctrl+Y").ok, false);
    assert.equal(rebind({}, "nope", "Ctrl+Y").ok, false);
    assert.equal(rebind({}, "task.new", "Hyper+Y").ok, false);
  });

  it("stores a valid rebind, resets with null or the default, and keeps others", () => {
    let r = rebind({}, "task.new", "mod+shift+y");
    assert.ok(r.ok);
    assert.deepEqual(r.ok && r.overrides, { "task.new": "Mod+Shift+Y" });
    r = rebind(r.ok ? r.overrides : {}, "control.open", "Ctrl+Alt+K");
    assert.ok(r.ok);
    assert.deepEqual(r.ok && r.overrides, { "task.new": "Mod+Shift+Y", "control.open": "Ctrl+Alt+K" });
    const reset = rebind(r.ok ? r.overrides : {}, "task.new", null);
    assert.deepEqual(reset.ok && reset.overrides, { "control.open": "Ctrl+Alt+K" });
    const toDefault = rebind(r.ok ? r.overrides : {}, "control.open", "Alt+Shift+C");
    assert.deepEqual(toDefault.ok && toDefault.overrides, { "task.new": "Mod+Shift+Y" });
  });

  it("a freed combo can be taken by another shortcut", () => {
    const a = rebind({}, "task.new", "Mod+Shift+Y");
    assert.ok(a.ok);
    const b = rebind(a.ok ? a.overrides : {}, "schedule.new", "Mod+N");
    assert.ok(b.ok, "⌘N is free once New task moved");
  });

  it("sanitizeOverrides drops unknown, fixed, invalid and clashing entries", () => {
    assert.deepEqual(
      sanitizeOverrides({ "task.new": "Mod+K", nope: "X", "switcher.next": "Ctrl+Y", "help.shortcuts": "F1", "control.open": "not a key!!" }),
      { "help.shortcuts": "F1" },
    );
    assert.deepEqual(sanitizeOverrides(null), {});
    assert.deepEqual(sanitizeOverrides(["Mod+K"]), {});
    // The stored (WS=find) format reads back.
    assert.deepEqual(sanitizeOverrides({ "split.focus_left": "ctrl+alt+left" }), { "split.focus_left": "Ctrl+Alt+ArrowLeft" });
  });
});

describe("matching", () => {
  it("Mod matches ⌘ or Ctrl; Ctrl means Control only", () => {
    assert.ok(comboMatches("Mod+K", ev("k", { meta: true }, "KeyK")));
    assert.ok(comboMatches("Mod+K", ev("k", { ctrl: true }, "KeyK")));
    assert.ok(!comboMatches("Mod+K", ev("k", {}, "KeyK")));
    assert.ok(comboMatches("Ctrl+Tab", ev("Tab", { ctrl: true }, "Tab")));
    assert.ok(!comboMatches("Ctrl+Tab", ev("Tab", { meta: true }, "Tab")));
    assert.ok(!comboMatches("Ctrl+Tab", ev("Tab", { ctrl: true, shift: true }, "Tab")));
  });

  it("is layout-safe: Option+Shift+C on a Mac types Ç but means C", () => {
    assert.ok(comboMatches("Alt+Shift+C", ev("Ç", { alt: true, shift: true }, "KeyC")));
    assert.ok(comboMatches("Alt+1", ev("¡", { alt: true }, "Digit1")));
  });

  it("? needs Shift to type and matches either way", () => {
    assert.ok(comboMatches("?", ev("?", { shift: true }, "Slash")));
    assert.ok(!comboMatches("?", ev("/", {}, "Slash")));
  });

  it("keycaps for the cheat-sheet", () => {
    assert.deepEqual(comboKeycaps("Mod+K", true), [["⌘", "K"]]);
    assert.deepEqual(comboKeycaps("Mod+K", false), [["Ctrl", "K"]]);
    assert.deepEqual(comboKeycaps("G I", true), [["G"], ["I"]]);
    assert.deepEqual(comboKeycaps("Ctrl+Alt+ArrowLeft", true), [["⌃", "⌥", "←"]]);
  });

  it("parseCombo refuses junk", () => {
    assert.throws(() => parseCombo(""));
    assert.throws(() => parseCombo("A B C"));
    assert.throws(() => parseCombo("Ctrl+"));
    assert.throws(() => parseCombo("Banana+K"));
  });

  it("a refusal carries a code and values the UI can translate", () => {
    const clash = rebind({}, "task.new", "Mod+K");
    assert.equal(clash.ok, false);
    if (!clash.ok) {
      assert.equal(clash.code, "taken");
      assert.equal(clash.values?.otherId, "palette.toggle");
    }
    const reserved = rebind({}, "task.new", "Mod+W");
    assert.ok(!reserved.ok && reserved.code === "reserved" && reserved.values?.combo === "Mod+W");
    const fixed = rebind({}, "switcher.next", "Mod+Y");
    assert.ok(!fixed.ok && fixed.code === "fixed");
    const unknown = rebind({}, "no.such", "Mod+Y");
    assert.ok(!unknown.ok && unknown.code === "unknown");
  });
});
