"use client";

// Marketr — CAD + Hardware slice 1: public (anonymous) share-link viewer.

import { Box, Download, Info } from "lucide-react";
import { CadViewer } from "@/app/dashboard/cad/views/CadViewer";
import { STEP_PREVIEW_MESSAGE, type CadFormat } from "@/lib/cad/types";

export function PublicCadViewer({
  token,
  modelName,
  versionNumber,
  fileName,
  format,
  previewAvailable,
  fileUrl,
  triangleCount,
  expiresAt,
}: {
  token: string;
  modelName: string;
  versionNumber: number;
  fileName: string;
  format: CadFormat;
  previewAvailable: boolean;
  fileUrl: string;
  triangleCount: number | null;
  expiresAt: string;
}) {
  return (
    <div className="min-h-screen bg-canvas p-4 md:p-8">
      <div className="mx-auto max-w-4xl">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-md bg-ink">
            <Box className="h-5 w-5 text-paper" aria-hidden />
          </span>
          <div>
            <h1 className="text-xl font-semibold text-ink" style={{ fontStretch: "115%" }}>
              {modelName}
            </h1>
            <p className="font-mono text-xs text-muted">
              Shared version v{versionNumber} · {fileName}
              {triangleCount !== null && ` · ${triangleCount.toLocaleString()} triangles`} · link
              expires {new Date(expiresAt).toLocaleDateString()}
            </p>
          </div>
        </div>

        {previewAvailable ? (
          <CadViewer fileUrl={fileUrl} format={format} fileName={fileName} />
        ) : (
          <div className="rounded-lg border border-line bg-paper p-6 shadow-hairline">
            <div className="flex items-start gap-3">
              <Info className="mt-0.5 h-5 w-5 shrink-0 text-ink" aria-hidden />
              <div>
                <h2 className="text-sm font-semibold text-ink">
                  {fileName} — {format.toUpperCase()}
                </h2>
                <p className="mt-1 max-w-xl text-sm text-muted">{STEP_PREVIEW_MESSAGE}</p>
                <a
                  href={`${fileUrl}?dl=1`}
                  className="mt-4 inline-flex h-10 items-center gap-2 rounded-full bg-ink px-4 text-sm font-semibold text-paper"
                >
                  <Download className="h-4 w-4" aria-hidden />
                  Download original
                </a>
              </div>
            </div>
          </div>
        )}

        <p className="mt-4 text-center text-xs text-muted">
          Shared from Marketr · this link expires automatically and can be revoked
          by its owner at any time.
        </p>
      </div>
    </div>
  );
}
