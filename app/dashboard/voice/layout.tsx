// Marketr — Phase 13D: shared voice section layout.
// Shared sub-tab nav across the voice tracks:
//   [Agents] [Sessions] [Scripts] [Consent]  ← Worker A (lead follow-up)
//   [Voiceover Studio] [Pronunciation]        ← Worker B (voiceovers)
// Worker B owns ONLY the Voiceover Studio + Pronunciation tab entries;
// the sibling owns the rest. Do not reformat — append-only edits.

import { VoiceNavTabs } from "./tabs";

export default function VoiceLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <VoiceNavTabs />
      {children}
    </div>
  );
}
