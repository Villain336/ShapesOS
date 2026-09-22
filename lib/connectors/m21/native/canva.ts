// Marketr — M21 Canva adapter.
//
// LIVE WIRING (not yet implemented): this adapter is MOCK-ONLY today. The
// live pass must call the Canva Connect API:
//   GET  https://api.canva.com/rest/v1/designs?query=...
//     → list_designs()
//   GET  https://api.canva.com/rest/v1/designs/{designId}
//     → get_design()
//   POST https://api.canva.com/rest/v1/exports
//        { design_id, format: { type: "png" | "jpg" | "pdf" } }
//     → export_design() (async job → poll the returned job id)
// Auth: OAuth2 via the Canva Connect API (review-gated in production — the
// integration must pass Canva's app review before non-test users can
// connect). Refresh via lib/vault/refresh.ts. Docs:
// https://www.canva.dev/docs/connect/
//
// MOCK MODE: deterministic demo design data; every row flagged mock: true,
// titles carry "(MOCK)". No network calls.

import type {
  ConnectorAdapter,
  ConnectorToolDef,
  DecryptedCredential,
  InvokeContext,
  InvokeResult,
} from "../types";
import { strProp, mockOk, fail } from "../types";

export class CanvaAdapter implements ConnectorAdapter {
  readonly key = "canva";
  readonly displayName = "Canva";
  readonly authType = "oauth2" as const;
  readonly configSchema = { type: "object", properties: {} };

  listTools(): ConnectorToolDef[] {
    return [
      {
        name: "list_designs",
        description: "List the connected user's Canva designs, optionally filtered by a query.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: { query: strProp("Optional search text, e.g. \"summer campaign\".") },
        },
      },
      {
        name: "get_design",
        description: "Get a design's metadata (title, thumbnail, updated time).",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: { designId: strProp("Canva design id.") },
          required: ["designId"],
        },
      },
      {
        name: "export_design",
        description: "Export a design as PNG/JPG/PDF and return the download URL.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: {
            designId: strProp("Canva design id."),
            format: strProp('"png", "jpg", or "pdf".'),
          },
          required: ["designId", "format"],
        },
      },
    ];
  }

  async invoke(
    tool: string,
    args: Record<string, unknown>,
    _credential: DecryptedCredential | null,
    _ctx: InvokeContext,
  ): Promise<InvokeResult> {
    switch (tool) {
      case "list_designs": {
        const designs = [
          { id: "DAG_mock_1", title: "Summer Whitening Promo (MOCK)", thumbnailUrl: "https://demo.local/mock/summer-whitening.png", updatedAt: "2026-09-20T10:00:00Z" },
          { id: "DAG_mock_2", title: "Implant Guide Cover (MOCK)", thumbnailUrl: "https://demo.local/mock/implant-cover.png", updatedAt: "2026-09-12T09:30:00Z" },
          { id: "DAG_mock_3", title: "Patient Review Card (MOCK)", thumbnailUrl: "https://demo.local/mock/review-card.png", updatedAt: "2026-09-01T15:00:00Z" },
        ];
        const q = (args.query as string | undefined)?.toLowerCase();
        return mockOk(
          (q ? designs.filter((d) => d.title.toLowerCase().includes(q)) : designs).map((d) => ({ ...d, mock: true })),
        );
      }
      case "get_design":
        return mockOk({
          id: args.designId,
          title: "Summer Whitening Promo (MOCK)",
          thumbnailUrl: "https://demo.local/mock/summer-whitening.png",
          updatedAt: "2026-09-20T10:00:00Z",
          mock: true,
        });
      case "export_design":
        return mockOk({
          designId: args.designId,
          format: args.format,
          downloadUrl: `https://demo.local/mock/export-${String(args.designId)}.${args.format}`,
          mock: true,
        });
      default:
        return fail(`Unknown tool "${tool}" for connector ${this.key}`);
    }
  }
}
