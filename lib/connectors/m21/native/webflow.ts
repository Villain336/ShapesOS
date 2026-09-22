// Marketr — M21 Webflow adapter.
//
// LIVE PATH (proven in-repo, M8): delegates to
// lib/connectors/webflow.ts (WebflowConnector) and
// lib/connectors/mock-webflow.ts (MockWebflowConnector). Live is called for
// real whenever a decrypted oauth2 credential with an access token is
// present. Mock is the default when no credential is connected.

import type {
  ConnectorAdapter,
  ConnectorToolDef,
  DecryptedCredential,
  InvokeContext,
  InvokeResult,
} from "../types";
import { strProp, mockOk, liveOk, fail } from "../types";
import { WebflowConnector } from "../../webflow";
import { MockWebflowConnector } from "../../mock-webflow";
import type { ContentKind, WebflowConfig } from "../../types";

interface WfCredential {
  token: string;
  siteId: string;
  demo: boolean;
}

function readConfig(
  credential: DecryptedCredential | null,
  ctx: InvokeContext,
  args: Record<string, unknown>,
): WfCredential | null {
  if (!credential || credential.kind !== "oauth2") return null;
  const p = credential.payload;
  const token = p.access_token as string | undefined;
  if (!token) return null;
  return {
    token: String(token),
    siteId: String(
      (args.siteId as string | undefined) ??
        (ctx.projectConfig?.siteId as string | undefined) ??
        "",
    ),
    demo: p.demo === true,
  };
}

export class WebflowM21Adapter implements ConnectorAdapter {
  readonly key = "webflow";
  readonly displayName = "Webflow";
  readonly authType = "oauth2" as const;
  readonly configSchema = {
    type: "object",
    properties: {
      siteId: {
        type: "string",
        description: "Default Webflow site id. Also accepted per-project via ProjectDataSource.projectConfig.",
      },
    },
  };

  listTools(): ConnectorToolDef[] {
    return [
      {
        name: "test_connection",
        description: "Verify the token and return the number of accessible Webflow sites.",
        mutating: false,
        argsSchema: { type: "object", properties: {} },
      },
      {
        name: "list_sites",
        description: "List accessible Webflow sites with their domains.",
        mutating: false,
        argsSchema: { type: "object", properties: {} },
      },
      {
        name: "list_collections",
        description: "List CMS collections for the configured site.",
        mutating: false,
        argsSchema: { type: "object", properties: {} },
      },
      {
        name: "list_items",
        description: "List CMS items in a collection.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: { collectionId: strProp("Webflow CMS collection id.") },
          required: ["collectionId"],
        },
      },
      {
        name: "publish_site",
        description: "Publish the site to its production domains.",
        mutating: true,
        argsSchema: { type: "object", properties: {} },
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
    if (!cfg) return this.invokeMock(tool, args);
    try {
      const wfCfg: WebflowConfig = { token: cfg.token, siteId: cfg.siteId, demo: cfg.demo };
      const conn = cfg.demo
        ? new MockWebflowConnector(wfCfg)
        : new WebflowConnector(wfCfg);
      const isLive = !cfg.demo;
      const wrap = (v: unknown): InvokeResult => (isLive ? liveOk(v) : mockOk(v));
      switch (tool) {
        case "test_connection":
          return wrap(await conn.test());
        case "list_sites":
          return wrap(await conn.listSites());
        case "list_collections":
          return wrap(await conn.listContent("collection" as ContentKind));
        case "list_items":
          return wrap(
            await conn.listItems(String(args.collectionId)),
          );
        case "publish_site":
          return wrap(await conn.publishSite());
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
  ): Promise<InvokeResult> {
    const conn = new MockWebflowConnector({ token: "", siteId: "mock-site-1", demo: true });
    switch (tool) {
      case "test_connection":
        return mockOk({ ok: true, info: "Connected — 1 site(s) accessible, using “Harbor Dental Studio (MOCK)”" });
      case "list_sites":
        return mockOk(await conn.listSites());
      case "list_collections":
        return mockOk(await conn.listContent("collection" as ContentKind));
      case "list_items":
        return mockOk(await conn.listItems(String(args.collectionId ?? "mock-col-1")));
      case "publish_site":
        return mockOk(await conn.publishSite());
      default:
        return fail(`Unknown tool "${tool}" for connector ${this.key}`);
    }
  }
}
