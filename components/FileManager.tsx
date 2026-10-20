"use client";

// ShapesOS — the Files app (Phase B, W3, track B1; Phase 18.2 content; Phase 21B drive).
// Phase 21B (WS=drive): the old four-tab list became a Finder-style Drive window — see
// components/drive/DriveApp.tsx. This wrapper keeps the page's props so /dashboard/files,
// ?file=<id> (opens the file's details) and ?path=<folder> keep working.

import { DriveApp } from "@/components/drive/DriveApp";

export function FileManager(props: {
  workspaceId: string;
  canEdit: boolean;
  canPurge: boolean;
  canAdmin?: boolean;
  initialFileId?: string | null;
  initialPath?: string | null;
}) {
  return <DriveApp {...props} />;
}
