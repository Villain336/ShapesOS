// ShapesOS — Phase 21B (WS=drive): one icon per kind of file. Lucide only; the icon is a
// shape, never colour (colour in this app is reserved for agent status).
import { File as FileIcon, FileArchive, FileAudio, FileImage, FileSpreadsheet, FileText, FileVideo, Folder, Presentation } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import type { FileClass } from "@/lib/drive/client/rows";

const ICONS: Record<FileClass, ComponentType<SVGProps<SVGSVGElement>>> = {
  folder: Folder,
  image: FileImage,
  pdf: FileText,
  text: FileText,
  sheet: FileSpreadsheet,
  document: FileText,
  slides: Presentation,
  audio: FileAudio,
  video: FileVideo,
  archive: FileArchive,
  other: FileIcon,
};

export function DriveIcon({ kind, className }: { kind: FileClass; className?: string }) {
  const Cmp = ICONS[kind];
  return <Cmp className={className ?? "size-4 shrink-0 text-muted"} aria-hidden />;
}
