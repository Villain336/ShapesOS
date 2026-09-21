// Marketr — mock WordPress connector (milestone 8).
//
// Deterministic demo WordPress site ("Harbor Dental Studio") so the full
// connect → browse → edit → publish flow works end-to-end without credentials
// or network access. Every row is flagged mock: true and the UI labels it
// honestly. Writes mutate an in-memory map (per server process); restarting
// resets the demo. Never ship as real data.

import type {
  ContentConnector,
  ContentDetail,
  ContentItem,
  ContentKind,
  SaveContentInput,
  WordPressConfig,
} from "./types";

interface MockPost {
  id: string;
  slug: string;
  status: string;
  title: string;
  content: string;
  updatedAt: string;
}

function seed(): { pages: Map<string, MockPost>; posts: Map<string, MockPost> } {
  const pages = new Map<string, MockPost>();
  const posts = new Map<string, MockPost>();
  pages.set("1", {
    id: "1",
    slug: "home",
    status: "publish",
    title: "Harbor Dental Studio — Gentle Dentistry (MOCK)",
    content:
      "<!-- Mock demo content -->\n<h1>Welcome to Harbor Dental Studio</h1>\n<p>Family dentistry with a gentle touch. (MOCK)</p>\n<a href=\"/contact\">Book a visit</a>",
    updatedAt: "2026-09-20T10:00:00Z",
  });
  pages.set("2", {
    id: "2",
    slug: "services",
    status: "publish",
    title: "Services (MOCK)",
    content:
      "<h1>Our services</h1>\n<ul><li>Cleanings</li><li>Whitening</li><li>Implants</li></ul>\n<p>(MOCK)</p>",
    updatedAt: "2026-09-18T14:30:00Z",
  });
  pages.set("3", {
    id: "3",
    slug: "contact",
    status: "draft",
    title: "Contact (MOCK)",
    content: "<h1>Contact us</h1>\n<p>123 Harbor Lane. (MOCK)</p>",
    updatedAt: "2026-09-15T09:00:00Z",
  });
  posts.set("101", {
    id: "101",
    slug: "5-tips-healthy-smile",
    status: "publish",
    title: "5 tips for a healthy smile (MOCK)",
    content: "<h1>5 tips for a healthy smile</h1>\n<p>Brush twice a day… (MOCK)</p>",
    updatedAt: "2026-09-10T12:00:00Z",
  });
  posts.set("102", {
    id: "102",
    slug: "why-floss",
    status: "draft",
    title: "Why flossing matters (MOCK)",
    content: "<h1>Why flossing matters</h1>\n<p>(MOCK)</p>",
    updatedAt: "2026-09-12T08:00:00Z",
  });
  return { pages, posts };
}

const store = seed();

export class MockWordPressConnector implements ContentConnector {
  readonly kind = "wordpress" as const;
  readonly name = "wordpress";
  readonly isLive = false;

  constructor(private cfg: WordPressConfig) {}

  private map(kind: ContentKind): Map<string, MockPost> {
    if (kind === "page") return store.pages;
    if (kind === "post") return store.posts;
    throw new Error(`WordPress has no content kind "${kind}"`);
  }

  private toItem(kind: ContentKind, p: MockPost): ContentItem {
    return {
      id: p.id,
      kind,
      title: p.title,
      slug: p.slug,
      status: p.status,
      link: `${this.cfg.baseUrl || "https://demo-wp.local"}/${p.slug}/`,
      updatedAt: p.updatedAt,
      mock: true,
    };
  }

  async test(): Promise<{ ok: boolean; info: string }> {
    return {
      ok: true,
      info: "Connected to “Harbor Dental Studio” (mock demo site — no real WordPress was contacted)",
    };
  }

  async listContent(kind: ContentKind): Promise<ContentItem[]> {
    return [...this.map(kind).values()].map((p) => this.toItem(kind, p));
  }

  async getContent(kind: ContentKind, id: string): Promise<ContentDetail> {
    const p = this.map(kind).get(id);
    if (!p) throw new Error(`No ${kind} with id ${id} (mock)`);
    return { ...this.toItem(kind, p), content: p.content, mock: true };
  }

  async saveContent(kind: ContentKind, input: SaveContentInput): Promise<ContentDetail> {
    const map = this.map(kind);
    const now = new Date().toISOString();
    if (input.id && map.has(input.id)) {
      const p = map.get(input.id)!;
      p.title = input.title;
      p.content = input.content;
      p.status = input.status;
      if (input.slug?.trim()) p.slug = input.slug.trim();
      p.updatedAt = now;
      return { ...this.toItem(kind, p), content: p.content, mock: true };
    }
    const ids = [...map.keys()].map(Number);
    const id = String(Math.max(...ids, 0) + 1);
    const slug =
      input.slug?.trim() ||
      input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
      `item-${id}`;
    const p: MockPost = {
      id,
      slug,
      status: input.status,
      title: input.title,
      content: input.content,
      updatedAt: now,
    };
    map.set(id, p);
    return { ...this.toItem(kind, p), content: p.content, mock: true };
  }

  async deleteContent(kind: ContentKind, id: string): Promise<{ ok: boolean }> {
    this.map(kind).delete(id);
    return { ok: true };
  }

  async listMedia(): Promise<
    { id: string; title: string; url: string | null; mime: string | null; updatedAt: string | null }[]
  > {
    return [
      {
        id: "201",
        title: "hero-smile",
        url: "https://demo-wp.local/wp-content/uploads/hero-smile.jpg",
        mime: "image/jpeg",
        updatedAt: "2026-09-01T10:00:00Z",
      },
    ];
  }

  async uploadMedia(args: { filename: string; bytes: Uint8Array; mime: string }): Promise<{ id: string; url: string | null }> {
    void args;
    return { id: "202", url: "https://demo-wp.local/wp-content/uploads/mock-upload.bin" };
  }
}
