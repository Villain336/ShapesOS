// Marketr — Pronunciation dictionary (Phase 13D Worker B).

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { PronunciationApp } from "./PronunciationApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Pronunciation — Marketr",
  description:
    "Per-workspace pronunciation dictionary for voiceovers, seeded from the company knowledge graph.",
};

export default async function PronunciationPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  await getOrCreateWorkspace(user.id, user.email);
  return <PronunciationApp />;
}
