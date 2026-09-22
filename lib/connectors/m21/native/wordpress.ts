// Marketr — M21 WordPress adapter.
//
// LIVE PATH (proven in-repo, M8): delegates to
// lib/connectors/wordpress.ts (WordPressConnector) and
// lib/connectors/mock-wordpress.ts (MockWordPressConnector) — same classes
// the milestone-8 UI already uses. Live is called for real whenever a
// decrypted api_key credential with usable fields is present. Mock is the
// default when no credential is connected.

import type {
  ConnectorAdapter,
  ConnectorToolDef,
  DecryptedCredential,
  InvokeContext,
  InvokeResult,
} from "../types";
import { strProp, mockOk, liveOk, fail } from "../types";
import { WordPressConnector } from "../../wordpress";
import { MockWordPressConnector } from "../../mock-wordpress";
import type { ContentKind, WordPressConfig } from "../../types";

type WpKind = "page" | "post";

function isWpKind(v: unknown): v is WpKind {
  return v === "page" || v === "post";
}

interface WpCredential {
  baseUrl: string;
  username: string;
  appPassword: string;
  demo: boolean;
}

/** Extract usable config from a decrypted credential + context. */
function readConfig(
  credential: DecryptedCredential | null,
  ctx: InvokeContext,
  args: Record<string, unknown>,
): WpCredential | null {
  if (!credential || credential.kind !== "api_key") return null;
  const p = credential.payload;
  const baseUrl =
    (p.baseUrl as string | undefined) ??
    (args.baseUrl as string | undefined) ??
    (ctx.projectConfig?.baseUrl as string | undefined);
  const username = p.username as string | undefined;
  const appPassword = p.apiKey as string | undefined;
  if (!baseUrl || !username || !appPassword) return null;
  return {
    baseUrl: String(baseUrl),
    username: String(username),
    appPassword: String(appPassword),
    demo: p.demo === true,
  };
}

function toConfig(w: WpCredential): WordPressConfig {
  return {
    baseUrl: w.baseUrl,
    username: w.username,
    appPassword: w.appPassword,
    demo: w.demo,
  };
}

export class WordPressM21Adapter implements ConnectorAdapter {
  readonly key = "wordpress";
  readonly displayName = "WordPress";
  readonly authType = "api_key" as const;
  readonly configSchema = {
    type: "object",
    properties: {
      baseUrl: {
        type: "string",
        description: "Site URL, e.g. https://client.example.com (no trailing slash).",
      },
    },
    required: ["baseUrl"],
  };

  listTools(): ConnectorToolDef[] {
    return [
      {
        name: "test_connection",
        description: "Verify credentials and return the connected site name.",
        mutating: false,
        argsSchema: { type: "object", properties: {} },
      },
      {
        name: "list_content",
        description: "List WordPress pages or posts (content-level only — no theme/plugin files).",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: {
            kind: strProp('"page" or "post".'),
          },
          required: ["kind"],
        },
      },
      {
        name: "get_content",
        description: "Fetch full content (HTML) of a page or post by id.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: {
            kind: strProp('"page" or "post".'),
            id: strProp("Content id."),
          },
          required: ["kind", "id"],
        },
      },
      {
        name: "save_content",
        description: "Create or update a page/post. status=publish goes live immediately.",
        mutating: true,
        argsSchema: {
          type: "object",
          properties: {
            kind: strProp('"page" or "post".'),
            title: strProp("Title."),
            content: strProp("HTML content."),
            status: strProp('"draft" or "publish".'),
            id: strProp("Id to update; omit to create."),
            slug: strProp("Slug for new content (optional)."),
          },
          required: ["kind", "title", "content", "status"],
        },
      },
    ];
  }

  async invoke(
    tool: string,
    args: Record<string, unknown>,
    credential: DecryptedCredential | null,
    ctx: InvokeContext,
  ): Promise<InvokeResult> {
    const cfg = readConfig(credential, ctx, args);
    if (!cfg) {
      // No usable credential → labeled mock (M8 demo site).
      return this.invokeMock(tool, args, toConfig({ baseUrl: "https://demo-wp.local", username: "", appPassword: "", demo: true }));
    }
    try {
      const conn = cfg.demo
        ? new MockWordPressConnector(toConfig(cfg))
        : await WordPressConnector.create(toConfig(cfg));
      const isLive = !cfg.demo;
      switch (tool) {
        case "test_connection": {
          const t = await conn.test();
          return isLive ? liveOk(t) : mockOk({ ...t, info: "Connected to “Harbor Dental Studio (MOCK)”" });
        }
        case "list_content": {
          if (!isWpKind(args.kind)) return fail('kind must be "page" or "post"');
          const items = await conn.listContent(args.kind as ContentKind);
          return isLive ? liveOk(items) : mockOk(items);
        }
        case "get_content": {
          if (!isWpKind(args.kind)) return fail('kind must be "page" or "post"');
          const detail = await conn.getContent(args.kind as ContentKind, String(args.id));
          return isLive ? liveOk(detail) : mockOk(detail);
        }
        case "save_content": {
          if (!isWpKind(args.kind)) return fail('kind must be "page" or "post"');
          const status = args.status === "publish" ? "publish" : "draft";
          const detail = await conn.saveContent(args.kind as ContentKind, {
            id: args.id !== undefined ? String(args.id) : undefined,
            title: String(args.title),
            slug: args.slug !== undefined ? String(args.slug) : undefined,
            content: String(args.content),
            status,
          });
          return isLive ? liveOk(detail) : mockOk(detail);
        }
        default:
          return fail(`Unknown tool "${tool}" for connector ${this.key}`);
      }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  private async invokeMock(
    tool: string,
    args: Record<string, unknown>,
    cfg: WordPressConfig,
  ): Promise<InvokeResult> {
    const conn = new MockWordPressConnector(cfg);
    switch (tool) {
      case "test_connection":
        return mockOk({ ok: true, info: "Connected to “Harbor Dental Studio (MOCK)”" });
      case "list_content":
        if (!isWpKind(args.kind)) return fail('kind must be "page" or "post"');
        return mockOk(await conn.listContent(args.kind as ContentKind));
      case "get_content":
        if (!isWpKind(args.kind)) return fail('kind must be "page" or "post"');
        return mockOk(await conn.getContent(args.kind as ContentKind, String(args.id)));
      case "save_content":
        if (!isWpKind(args.kind)) return fail('kind must be "page" or "post"');
        return mockOk(
          await conn.saveContent(args.kind as ContentKind, {
            id: args.id !== undefined ? String(args.id) : undefined,
            title: String(args.title),
            slug: args.slug !== undefined ? String(args.slug) : undefined,
            content: String(args.content),
            status: args.status === "publish" ? "publish" : "draft",
          }),
        );
      default:
        return fail(`Unknown tool "${tool}" for connector ${this.key}`);
    }
  }
}
