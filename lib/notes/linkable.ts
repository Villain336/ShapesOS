// ShapesOS — Phase 18.2: record kinds a note never links to (shared by the
// notes service and the client-side record picker; no server imports here).
//
// These kinds are PERSONAL and a note can be shared with the workspace, so a
// link (and its label) would leak them: "mail" — a member's own mailbox
// threads (Spotlight shows them to their owner only), and "chat_message" — a
// member's own Assistant chats (Spotlight shows them to their author only).

import type { RecordKind } from "@/lib/search/kinds";

export const UNLINKABLE_KINDS: readonly RecordKind[] = ["mail", "chat_message"];

export const UNLINKABLE_REASON: Partial<Record<RecordKind, string>> = {
  mail: "Mail threads are personal, so a note can't link to one.",
  chat_message: "Assistant chats are personal, so a note can't link to one.",
};

export function isUnlinkableKind(kind: string): boolean {
  return (UNLINKABLE_KINDS as readonly string[]).includes(kind);
}
