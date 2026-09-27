// Marketr — Phase 11 "Canvas": curated template pack registry.
// Generated assets live in ./template-data/pack.json (built deterministically by
// `npx tsx scripts/generate-template-pack.ts`). This module converts each entry
// into a DesignTemplate whose build() returns a deep copy with FRESH ids —
// applying the same template twice must never create duplicate element ids.

import packJson from "./template-data/pack.json";
import {
  newId,
  type DesignDocument,
  type DesignElement,
  type DesignTemplate,
} from "./types";

interface PackEntry {
  key: string;
  name: string;
  category: "social" | "ads" | "web" | "print";
  width: number;
  height: number;
  description: string;
  document: DesignDocument;
}

function freshDocument(doc: DesignDocument): DesignDocument {
  const clone: DesignDocument = JSON.parse(JSON.stringify(doc));
  const idMap = new Map<string, string>();
  const fresh = (old: string): string => {
    let id = idMap.get(old);
    if (!id) {
      id = newId("tpl");
      idMap.set(old, id);
    }
    return id;
  };
  for (const page of clone.pages) {
    page.id = fresh(page.id);
    for (const el of page.elements as DesignElement[]) {
      el.id = fresh(el.id);
    }
  }
  return clone;
}

const entries = packJson as PackEntry[];

export const PACK_TEMPLATES: DesignTemplate[] = entries.map((e) => ({
  key: `pack:${e.key}`,
  name: e.name,
  category: e.category,
  width: e.width,
  height: e.height,
  description: e.description,
  build: () => freshDocument(e.document),
}));

export function getPackTemplate(key: string): DesignTemplate | undefined {
  return PACK_TEMPLATES.find((t) => t.key === key);
}
