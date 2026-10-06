"use client";

// ShapesOS — Phase 18.3 (WS=trust): Settings → You → Keyboard opens the
// 18.1 shortcut sheet (components/desk/ShortcutsDialog) for rebinding — one
// rebinding UI, not a second one. The sheet lives in the dashboard shell and
// listens for OPEN_SHORTCUTS_EVENT; a saved change refreshes this page.

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Keyboard } from "lucide-react";
import { aosButton } from "@/components/aos/button";
import { openShortcuts, SHORTCUTS_CHANGED_EVENT } from "@/components/desk/events";

export function OpenShortcutsButton({ label }: { label: string }) {
  const router = useRouter();
  useEffect(() => {
    const onChange = () => router.refresh();
    window.addEventListener(SHORTCUTS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(SHORTCUTS_CHANGED_EVENT, onChange);
  }, [router]);
  return (
    <button type="button" onClick={openShortcuts} className={aosButton({ variant: "primary" })}>
      <Keyboard size={16} aria-hidden />
      {label}
    </button>
  );
}
