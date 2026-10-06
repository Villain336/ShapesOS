"use client";

// ShapesOS — Phase 18.3 (WS=flow): the share sheet as a dialog, for places
// that have no button to anchor a popover to (⌘K record actions call
// openShareSheet(record)). Mounted once in the dashboard layout.

import { useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Share2 } from "lucide-react";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { ShareRecord, ShareRole } from "@/lib/share/registry";
import { SHARE_SHEET_EVENT, ShareMenuContent } from "./ShareMenu";

export function ShareSheetHost({ role, workspaceId }: { role: ShareRole | null; workspaceId: string | null }) {
  const { t } = useI18n();
  const [record, setRecord] = useState<ShareRecord | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      const r = (e as CustomEvent<ShareRecord>).detail;
      if (r && typeof r.id === "string" && typeof r.href === "string") setRecord(r);
    };
    window.addEventListener(SHARE_SHEET_EVENT, on);
    return () => window.removeEventListener(SHARE_SHEET_EVENT, on);
  }, []);
  return (
    <Dialog.Root open={!!record} onOpenChange={(o) => (!o ? setRecord(null) : undefined)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-night/30" />
        <Dialog.Popup className="fixed top-[14%] left-1/2 z-50 max-h-[76vh] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 overflow-y-auto rounded-lg bg-paper p-2 shadow-overlay">
          <Dialog.Title className="flex items-center gap-2 px-2 pt-1 pb-2 aos-subheading">
            <Share2 className="size-5" aria-hidden />
            <span className="truncate">{record ? t("flow.share.title", { title: record.title }) : ""}</span>
          </Dialog.Title>
          {record ? <ShareMenuContent record={record} role={role} workspaceId={workspaceId} onDone={() => setRecord(null)} /> : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default ShareSheetHost;
