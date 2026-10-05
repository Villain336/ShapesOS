// Marketr — CAD + Hardware slice 1: public share-link viewer page.
// Fail-closed: unknown, revoked, or expired tokens → 404 (no distinction
// leaks). The resolved version renders in the three.js viewer for STL/OBJ;
// STEP shows the honest preview-unavailable panel.

import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { PrismaCadStore } from "@/lib/cad/prisma-store";
import { CadError } from "@/lib/cad/types";
import { PublicCadViewer } from "./PublicCadViewer";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }) {
  return { title: "Shared CAD model — ShapesOS" };
}

export default async function PublicCadPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const store = new PrismaCadStore(prisma);
  try {
    const { model, version, link } = await store.resolveShareToken(token);
    return (
      <PublicCadViewer
        token={token}
        modelName={model.name}
        versionNumber={version.versionNumber}
        fileName={version.fileName}
        format={version.format}
        previewAvailable={version.previewAvailable}
        fileUrl={`/api/cad/public/${token}/file`}
        triangleCount={version.triangleCount}
        expiresAt={link.expiresAt.toISOString()}
      />
    );
  } catch (e) {
    if (e instanceof CadError) notFound();
    throw e;
  }
}
