// Marketr — run approval actions (Phase B, W2). Client island for the
// supervised approve/reject buttons on the run detail page.

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Notice, btnCls, dangerBtnCls, type NoticeState } from "@/components/settings/ui";

export default function RunApprovalActions({
  runId,
  workspaceId,
}: {
  runId: string;
  workspaceId: string;
}) {
  const router = useRouter();
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState(false);

  async function decide(approve: boolean) {
    setBusy(true);
    setNotice(null);
    const r = await fetch(`/api/scheduler/runs/${runId}/${approve ? "approve" : "reject"}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) {
      setNotice({ kind: "error", message: j.error ?? "Decision failed" });
      return;
    }
    setNotice({ kind: "ok", message: approve ? "Run approved and executing." : "Run rejected — nothing executed." });
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      <Notice notice={notice} />
      <div className="flex gap-2">
        <button className={btnCls} disabled={busy} onClick={() => decide(true)}>
          Approve and run
        </button>
        <button className={dangerBtnCls} disabled={busy} onClick={() => decide(false)}>
          Reject
        </button>
      </div>
    </div>
  );
}
