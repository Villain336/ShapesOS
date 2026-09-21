// Marketr — Webflow content connector (milestone 8, live implementation).
//
// Auth: Webflow API v2 token (site token or workspace token), encrypted at
// rest with the milestone-6 crypto helper — decrypted server-side only, never
// sent to the client. Header: `Authorization: Bearer <token>` +
// `accept-version: 2.0.0`.
//
// Scope (honest): the Webflow API v2 exposes CMS content — sites, collections,
// collection items, and site publishing. It cannot edit page designs, layouts,
// or custom code visually; those remain designer-only. The UI must label this
// as content + publish access. Untested against the live API from this sandbox
// (egress blocked); the mock in ./mock-webflow.ts covers the full flow.

import type {
  ContentConnector,
  ContentDetail,
  ContentItem,
  ContentKind,
  ContentOpts,
  SaveContentInput,
  WebflowConfig,
} from "./types";

const API = "https://api.webflow.com";

interface WfSite {
  id: string;
  displayName?: string;
  shortName?: string;
  customDomains?: { url?: string }[];
}

interface WfCollection {
  id: string;
  displayName?: string;
  slug?: string;
  singularName?: string;
}

interface WfItem {
  id: string;
  cmsLocaleId?: string;
  lastPublished?: string | null;
  lastUpdated?: string | null;
  fieldData: Record<string, unknown>;
}

function titleOf(fieldData: Record<string, unknown>): string {
  for (const key of ["name", "title", "heading", "post-title"]) {
    const v = fieldData[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "(untitled item)";
}

function slugOf(fieldData: Record<string, unknown>): string {
  const v = fieldData.slug;
  return typeof v === "string" ? v : "";
}

export class WebflowConnector implements ContentConnector {
  readonly kind = "webflow" as const;
  readonly name = "webflow";
  readonly isLive = true;

  constructor(private cfg: WebflowConfig) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.token}`,
      "accept-version": "2.0.0",
      Accept: "application/json",
      ...(extra ?? {}),
    };
  }

  private async wf<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        ...init,
        headers: { ...this.headers(), ...(init?.headers ?? {}) },
      });
    } catch (err) {
      throw new Error(
        `Webflow request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Webflow API error ${res.status}: ${text.slice(0, 300) || res.statusText}`,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async test(): Promise<{ ok: boolean; info: string }> {
    const data = await this.wf<{ sites?: WfSite[] }>("/v2/sites");
    const sites = data.sites ?? [];
    const target = this.cfg.siteId
      ? sites.find((s) => s.id === this.cfg.siteId)
      : sites[0];
    const name = target?.displayName ?? target?.shortName ?? "your Webflow workspace";
    return {
      ok: true,
      info: `Connected — ${sites.length} site(s) accessible, using “${name}”`,
    };
  }

  /* -- ContentConnector: Webflow "pages/posts" map to CMS collections. -- */

  async listSites(): Promise<{ id: string; name: string; domains: string[] }[]> {
    const data = await this.wf<{ sites?: WfSite[] }>("/v2/sites");
    return (data.sites ?? []).map((s) => ({
      id: s.id,
      name: s.displayName ?? s.shortName ?? s.id,
      domains: (s.customDomains ?? [])
        .map((d) => d.url)
        .filter((u): u is string => !!u),
    }));
  }

  private siteId(): string {
    if (!this.cfg.siteId) throw new Error("No Webflow site selected for this connection");
    return this.cfg.siteId;
  }

  async listContent(kind: ContentKind): Promise<ContentItem[]> {
    if (kind === "collection") {
      const data = await this.wf<{ collections?: WfCollection[] }>(
        `/v2/sites/${this.siteId()}/collections`,
      );
      return (data.collections ?? []).map((c) => ({
        id: c.id,
        kind: "collection" as const,
        title: c.displayName ?? c.slug ?? c.id,
        slug: c.slug ?? c.id,
        status: "collection",
        updatedAt: null,
      }));
    }
    throw new Error(
      `Webflow content lives in CMS collections — pick a collection first`,
    );
  }

  async listItems(collectionId: string): Promise<ContentItem[]> {
    const data = await this.wf<{ items?: WfItem[] }>(
      `/v2/collections/${encodeURIComponent(collectionId)}/items`,
    );
    return (data.items ?? []).map((i) => ({
      id: i.id,
      kind: "item" as const,
      title: titleOf(i.fieldData ?? {}),
      slug: slugOf(i.fieldData ?? {}),
      status: i.lastPublished ? "published" : "draft",
      collectionId,
      updatedAt: i.lastUpdated ?? null,
    }));
  }

  private toDetail(collectionId: string, item: WfItem): ContentDetail {
    return {
      id: item.id,
      kind: "item",
      title: titleOf(item.fieldData ?? {}),
      slug: slugOf(item.fieldData ?? {}),
      status: item.lastPublished ? "published" : "draft",
      collectionId,
      updatedAt: item.lastUpdated ?? null,
      content: JSON.stringify(item.fieldData ?? {}, null, 2),
    };
  }

  async getContent(kind: ContentKind, id: string, opts?: ContentOpts): Promise<ContentDetail> {
    if (kind !== "item") throw new Error("Webflow items must be fetched with kind 'item'");
    const collectionId = opts?.collectionId;
    if (!collectionId) throw new Error("Webflow getContent needs opts.collectionId");
    const item = await this.wf<WfItem>(
      `/v2/collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(id)}`,
    );
    return this.toDetail(collectionId, item);
  }

  async saveContent(kind: ContentKind, input: SaveContentInput, opts?: ContentOpts): Promise<ContentDetail> {
    if (kind !== "item") throw new Error("Webflow items must be saved with kind 'item'");
    const collectionId = input.collectionId ?? opts?.collectionId;
    if (!collectionId) throw new Error("Webflow saveContent needs a collectionId");
    let fieldData: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(input.content);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("fieldData must be a JSON object");
      fieldData = parsed as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `Invalid fieldData JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (input.title && !fieldData.name && !fieldData.title)
      fieldData.name = input.title;
    if (input.slug && !fieldData.slug) fieldData.slug = input.slug;
    if (input.status === "publish") fieldData["_archived"] = false;

    if (input.id) {
      const item = await this.wf<WfItem>(
        `/v2/collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(input.id)}`,
        {
          method: "PATCH",
          headers: this.headers({ "Content-Type": "application/json" }),
          body: JSON.stringify({ fieldData }),
        },
      );
      return this.toDetail(collectionId, item);
    }
    const item = await this.wf<WfItem>(
      `/v2/collections/${encodeURIComponent(collectionId)}/items`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ fieldData }),
      },
    );
    return this.toDetail(collectionId, item);
  }

  async deleteContent(kind: ContentKind, id: string, opts?: ContentOpts): Promise<{ ok: boolean }> {
    if (kind !== "item") throw new Error("Webflow items must be deleted with kind 'item'");
    const collectionId = opts?.collectionId;
    if (!collectionId) throw new Error("Webflow deleteContent needs opts.collectionId");
    await this.wf(
      `/v2/collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    return { ok: true };
  }

  /* -- Publishing (extra, beyond the ContentConnector interface) -- */

  /**
   * Publish CMS changes to the site. Honest scope: this pushes CMS content
   * live; it does not edit page designs. `domains` optional — omit to
   * publish to the site's default (staging) domains.
   */
  async publishSite(args?: { domains?: string[] }): Promise<{ ok: boolean; mock?: boolean }> {
    await this.wf(`/v2/sites/${this.siteId()}/publish`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(
        args?.domains?.length ? { customDomains: args.domains } : {},
      ),
    });
    return { ok: true };
  }
}
