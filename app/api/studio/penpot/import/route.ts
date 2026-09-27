// Marketr — Penpot design-token import API (Phase 12 "Reconsider trio").
// POST /api/studio/penpot/import
//   { mode: "api", fileId }        — live get-file read (needs PENPOT_BASE_URL
//                                    + PENPOT_ACCESS_TOKEN; beta: Penpot's RPC
//                                    API is an internal contract)
//   { mode: "paste", tokensJson }  — pasted Tokens-tab export; works with no
//                                    Penpot setup at all
// → { brand, kitColors, kitFonts, source, fileName? } in the same shape as the
// Brandfetch lookup so the editor applies it with the same code path.
// Credentials stay on the server; the browser only sees trimmed token data.
// Imports are metered per tenant (0-credit ledger event; same pattern as
// brandfetch_lookup).

import { guardWorkspace, httpErrorResponse, readJson } from "../../designs/_lib";
import {
  PenpotApiError,
  PenpotInputError,
  PenpotNotConfiguredError,
  importPenpotTokensViaApi,
  importPenpotTokensViaPaste,
} from "@/lib/design/penpot";
import { meter } from "@/lib/metering/service";
import { hourBucket } from "@/lib/metering/wiring";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });

    let body: Record<string, unknown>;
    try {
      body = (await readJson(req)) as Record<string, unknown>;
    } catch (e) {
      if (e instanceof PenpotInputError) {
        return Response.json({ error: e.message, code: "penpot_bad_request" }, { status: 400 });
      }
      throw e;
    }
    const mode = body.mode;

    try {
      const imp =
        mode === "api"
          ? await importPenpotTokensViaApi(typeof body.fileId === "string" ? body.fileId : "")
          : mode === "paste"
            ? await importPenpotTokensViaPaste(typeof body.tokensJson === "string" ? body.tokensJson : "")
            : (() => {
                throw new PenpotInputError('mode must be "api" or "paste".');
              })();

      // Per-tenant metering, best-effort: metering never breaks an import.
      await meter({
        workspaceId: workspace.id,
        action: "penpot_import",
        idempotencyKey: `penpot:${workspace.id}:${imp.source}:${imp.brand.name}:${hourBucket()}`,
        evidenceRef: `penpot:${imp.source}`,
      }).catch(() => {});

      return Response.json(imp);
    } catch (e) {
      if (e instanceof PenpotNotConfiguredError) {
        return Response.json({ error: e.message, code: e.code }, { status: 400 });
      }
      if (e instanceof PenpotInputError) {
        return Response.json({ error: e.message, code: "penpot_bad_request" }, { status: 400 });
      }
      if (e instanceof PenpotApiError && e.status === 0) {
        return Response.json({ error: e.message, code: "penpot_unreachable" }, { status: 502 });
      }
      const message = e instanceof PenpotApiError ? e.message : "Penpot import failed unexpectedly.";
      return Response.json({ error: message, code: "penpot_failed" }, { status: 502 });
    }
  } catch (e) {
    return httpErrorResponse(e);
  }
}
