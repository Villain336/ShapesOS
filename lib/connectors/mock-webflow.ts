// Marketr — mock Webflow connector (milestone 8).
//
// Deterministic demo Webflow workspace ("Northwind Studio") so the full
// connect → browse → edit → publish flow works end-to-end without a token or
// network access. Every row is flagged mock: true and the UI labels it
// honestly. Writes mutate an in-memory map (per server process); restarting
// resets the demo. Never ship as real data.

import type {
  ContentConnector,
  ContentDetail,
  ContentItem,
  ContentKind,
  ContentOpts,
  SaveContentInput,
  WebflowConfig,
} from "./types";

interface MockCollection {
  id: string;
  title: string;
  slug: string;
}

interface MockItem {
  id: string;
  fieldData: Record<string, unknown>;
  status: string;
  updatedAt: string;
}

const collections: MockCollection[] = [
  { id: "col-blog", title: "Blog Posts", slug: "blog-posts" },
  { id: "col-landing", title: "Landing Pages", slug: "landing-pages" },
];

const items = new Map<string, MockItem[]>();

function seed(): void {
  items.set("col-blog", [
    {
      id: "item-b1",
      status: "published",
      updatedAt: "2026-09-19T11:00:00Z",
      fieldData: {
        name: "How we cut client CAC by 40% (MOCK)",
        slug: "cut-cac-40",
        "post-body": "<p>Content marketing compounds. (MOCK)</p>",
      },
    },
    {
      id: "item-b2",
      status: "draft",
      updatedAt: "2026-09-21T08:00:00Z",
      fieldData: {
        name: "SEO checklist for 2026 (MOCK)",
        slug: "seo-checklist-2026",
        "post-body": "<p>Draft body. (MOCK)</p>",
      },
    },
  ]);
  items.set("col-landing", [
    {
      id: "item-l1",
      status: "published",
      updatedAt: "2026-09-17T16:00:00Z",
      fieldData: {
        name: "Spring promo page (MOCK)",
        slug: "spring-promo",
        "page-html": "<h1>Spring promo (MOCK)</h1>",
      },
    },
  ]);
}

seed();

function titleOf(fd: Record<string, unknown>): string {
  const v = fd.name ?? fd.title;
  return typeof v === "string" ? v : "(untitled item)";
}

export class MockWebflowConnector implements ContentConnector {
  readonly kind = "webflow" as const;
  readonly name = "webflow";
  readonly isLive = false;

  constructor(private cfg: WebflowConfig) {}

  private toItem(collectionId: string, i: MockItem): ContentItem {
    const slug = typeof i.fieldData.slug === "string" ? i.fieldData.slug : "";
    return {
      id: i.id,
      kind: "item",
      title: titleOf(i.fieldData),
      slug,
      status: i.status,
      collectionId,
      updatedAt: i.updatedAt,
      mock: true,
    };
  }

  async test(): Promise<{ ok: boolean; info: string }> {
    return {
      ok: true,
      info: "Connected — 1 site accessible, using “Northwind Studio” (mock demo workspace — no real Webflow was contacted)",
    };
  }

  async listSites(): Promise<{ id: string; name: string; domains: string[] }[]> {
    return [{ id: "site-demo", name: "Northwind Studio", domains: ["northwind-demo.webflow.io"] }];
  }

  async listContent(kind: ContentKind): Promise<ContentItem[]> {
    if (kind !== "collection")
      throw new Error("Webflow content lives in CMS collections (mock)");
    return collections.map((c) => ({
      id: c.id,
      kind: "collection" as const,
      title: c.title,
      slug: c.slug,
      status: "collection",
      updatedAt: null,
      mock: true,
    }));
  }

  async listItems(collectionId: string): Promise<ContentItem[]> {
    return (items.get(collectionId) ?? []).map((i) => this.toItem(collectionId, i));
  }

  async getContent(kind: ContentKind, id: string, opts?: ContentOpts): Promise<ContentDetail> {
    if (kind !== "item") throw new Error("Webflow items must be fetched with kind 'item' (mock)");
    const collectionId = opts?.collectionId;
    if (!collectionId) throw new Error("getContent needs opts.collectionId (mock)");
    const item = (items.get(collectionId) ?? []).find((i) => i.id === id);
    if (!item) throw new Error(`No item ${id} in ${collectionId} (mock)`);
    return {
      ...this.toItem(collectionId, item),
      content: JSON.stringify(item.fieldData, null, 2),
      mock: true,
    };
  }

  async saveContent(kind: ContentKind, input: SaveContentInput, opts?: ContentOpts): Promise<ContentDetail> {
    if (kind !== "item") throw new Error("Webflow items must be saved with kind 'item' (mock)");
    const collectionId = input.collectionId ?? opts?.collectionId;
    if (!collectionId) throw new Error("saveContent needs a collectionId (mock)");
    let fieldData: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(input.content);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("fieldData must be a JSON object");
      fieldData = parsed as Record<string, unknown>;
    } catch (err) {
      throw new Error(`Invalid fieldData JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (input.title && !fieldData.name && !fieldData.title) fieldData.name = input.title;
    if (input.slug && !fieldData.slug) fieldData.slug = input.slug;
    const list = items.get(collectionId) ?? [];
    const now = new Date().toISOString();
    const normStatus = input.status === "publish" ? "published" : "draft";
    if (input.id) {
      const item = list.find((i) => i.id === input.id);
      if (!item) throw new Error(`No item ${input.id} (mock)`);
      item.fieldData = fieldData;
      item.status = normStatus;
      item.updatedAt = now;
      return { ...this.toItem(collectionId, item), content: JSON.stringify(fieldData, null, 2), mock: true };
    }
    const item: MockItem = {
      id: `item-mock-${Date.now()}`,
      fieldData,
      status: normStatus,
      updatedAt: now,
    };
    list.push(item);
    items.set(collectionId, list);
    return { ...this.toItem(collectionId, item), content: JSON.stringify(fieldData, null, 2), mock: true };
  }

  async deleteContent(kind: ContentKind, id: string, opts?: ContentOpts): Promise<{ ok: boolean }> {
    if (kind !== "item") throw new Error("Webflow items must be deleted with kind 'item' (mock)");
    const collectionId = opts?.collectionId;
    if (!collectionId) throw new Error("deleteContent needs opts.collectionId (mock)");
    const list = (items.get(collectionId) ?? []).filter((i) => i.id !== id);
    items.set(collectionId, list);
    return { ok: true };
  }

  async publishSite(): Promise<{ ok: boolean; mock?: boolean }> {
    return { ok: true, mock: true };
  }
}
