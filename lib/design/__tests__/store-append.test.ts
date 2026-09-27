// Marketr — Phase 11 "Canvas": store.appendPages (AI draft pages) tests.
// Run: npx tsx --test lib/design/__tests__/store-append.test.ts

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { useDesignStore } from "../store";
import { blankDocument, type DesignPage } from "../types";

function reset() {
  useDesignStore.setState({
    document: null,
    activePageId: null,
    selectedIds: [],
    zoom: 1,
    past: [],
    future: [],
    dirty: false,
  });
}

function aiPage(name: string): DesignPage {
  return {
    id: "ai-page-1",
    name,
    width: 1080,
    height: 1080,
    background: "#ffffff",
    elements: [
      {
        id: "ai-1",
        type: "text",
        name: "Headline",
        x: 100,
        y: 100,
        rotation: 0,
        opacity: 1,
        visible: true,
        locked: false,
        text: "Hello",
        fontFamily: "Inter",
        fontSize: 64,
        fontStyle: "bold",
        fill: "#1c1917",
        align: "center",
        lineHeight: 1.2,
        letterSpacing: 0,
        width: 880,
      },
    ],
  };
}

beforeEach(reset);

describe("appendPages", () => {
  it("appends AI pages with fresh ids and activates the first", () => {
    const s = useDesignStore.getState();
    s.loadDocument(blankDocument(1080, 1080));
    const before = useDesignStore.getState().document!.pages.length;
    s.appendPages([aiPage("AI draft")]);
    const st = useDesignStore.getState();
    assert.equal(st.document!.pages.length, before + 1);
    const added = st.document!.pages[before]!;
    assert.notEqual(added.id, "ai-page-1");
    assert.notEqual(added.elements[0]!.id, "ai-1");
    assert.equal(st.activePageId, added.id);
    assert.equal(st.document!.pages[before]!.elements[0]!.type, "text");
  });

  it("falls back to a draft name when the AI omits one", () => {
    const s = useDesignStore.getState();
    s.loadDocument(blankDocument(1080, 1080));
    const p = aiPage("   ");
    s.appendPages([p]);
    const st = useDesignStore.getState();
    assert.ok(st.document!.pages[1]!.name.startsWith("AI draft"));
  });

  it("is a no-op without a document or pages", () => {
    const s = useDesignStore.getState();
    s.appendPages([aiPage("x")]); // no document loaded
    assert.equal(useDesignStore.getState().document, null);
    s.loadDocument(blankDocument(1080, 1080));
    s.appendPages([]);
    assert.equal(useDesignStore.getState().document!.pages.length, 1);
  });

  it("marks the document dirty so autosave persists the draft", () => {
    const s = useDesignStore.getState();
    s.loadDocument(blankDocument(1080, 1080));
    s.markClean();
    s.appendPages([aiPage("AI draft")]);
    assert.equal(useDesignStore.getState().dirty, true);
  });
});
