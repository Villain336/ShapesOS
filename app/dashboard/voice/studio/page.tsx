// Marketr — Voiceover Studio (Phase 13D Worker B).

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { VoiceoverStudio } from "./VoiceoverStudio";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Voiceover Studio — Marketr",
  description:
    "TTS narration tracks for clips and video: paste a script, pick a VoiceStudio voice, render, attach to a clip.",
};

export default async function VoiceoverStudioPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  await getOrCreateWorkspace(user.id, user.email);
  return <VoiceoverStudio />;
}
