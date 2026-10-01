// Marketr — Dataset Builder slice 1 API.
// GET /api/datasets/drive/files?connectionId=… — list ingestable files in the
// connected Google Drive through Nango Cloud. Fails closed with a clear
// message when Drive is not connected (no silent empty state).

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import {
  NangoCloudDriveAdapter,
  nangoCloudConfigFromEnv,
} from "@/lib/datasetbuilder/nango";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const { workspace } = await guardWorkspace();
    void workspace;
    const { searchParams } = new URL(req.url);
    const connectionId = searchParams.get("connectionId") ?? "";
    const adapter = new NangoCloudDriveAdapter(
      nangoCloudConfigFromEnv(connectionId),
    );
    const files = await adapter.listFiles({ limit: 100 });
    return Response.json({
      files: files.map((f) => ({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        sizeBytes: f.sizeBytes,
        modifiedTime: f.modifiedTime,
      })),
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
