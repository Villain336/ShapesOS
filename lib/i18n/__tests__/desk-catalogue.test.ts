// ShapesOS — Phase 18.1 (integration): the desk speaks both shell languages.
// Every desktop widget and every keyboard shortcut has its text in en AND es
// (read through widgetText / shortcutText), the English catalogue says
// exactly what the registries say (one source of English), and the view
// layer translates without a provider (English fallback).
// Run: npx tsx --test lib/i18n/__tests__/desk-catalogue.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { en } from "../messages/en";
import { es } from "../messages/es";
import { createTranslator, mergeCatalogues, shortcutText, widgetText } from "../index";
import { WIDGETS, WIDGET_IDS } from "@/lib/desktop/widgets";
import { SHORTCUTS } from "@/lib/keyboard/shortcuts";
import { deriveBanners, listJoin } from "@/lib/aos/home";

const ES = mergeCatalogues(en, es);

describe("desk catalogue coverage", () => {
  it("every widget has a title and description in both languages; English matches the registry", () => {
    for (const id of WIDGET_IDS) {
      const e = widgetText(en, id);
      const s = widgetText(es, id);
      assert.equal(e.title, WIDGETS[id].title, `en title ${id}`);
      assert.equal(e.description, WIDGETS[id].description, `en description ${id}`);
      assert.ok(s.title && s.description, `es ${id}`);
      assert.notEqual(s.description, e.description, `es description ${id} is translated`);
    }
  });

  it("every shortcut has a label (and its hint) in both languages; English matches the registry", () => {
    for (const sc of SHORTCUTS) {
      const e = shortcutText(en, sc.id);
      const s = shortcutText(es, sc.id);
      assert.equal(e.label, sc.label, `en label ${sc.id}`);
      assert.equal(e.hint, sc.hint, `en hint ${sc.id}`);
      assert.ok(s.label, `es label ${sc.id}`);
      if (sc.hint) assert.ok(s.hint, `es hint ${sc.id}`);
      assert.notEqual(s.label, e.label, `es label ${sc.id} is translated`);
    }
    const groups = new Set(SHORTCUTS.map((s) => s.group));
    for (const g of groups) assert.ok((en.desk.shortcuts.groups as Record<string, string>)[g], `group ${g}`);
  });
});

describe("Home banners in the person's language", () => {
  it("English by default (unchanged wording), Spanish with the es translator", () => {
    const input = { approvals: { actionable: 2, sources: ["Misión", "Publicación social"] }, failed: [] };
    assert.equal(deriveBanners(input)[0]!.title, "2 approvals are waiting on you");
    const t = createTranslator("es", ES);
    const [b] = deriveBanners(input, t);
    assert.equal(b!.title, "2 aprobaciones te están esperando");
    assert.match(b!.description, /^Misión y Publicación social se detuvo/);
    assert.equal(b!.action?.label, "Revisar todo");
    assert.equal(listJoin(["a", "b", "c", "d"], 3, t), "a, b, c y 1 más");
  });
});
