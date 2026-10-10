// ShapesOS — Phase 21A (WS=agentweb): Ask (/dashboard/ask).
// Any member can ask; what the workspace index shows them is decided by their role
// and user, as in ⌘K. ?answer=<id> reopens one of their own answers.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { getMembership, roleAtLeast } from "@/lib/authz";
import { getI18n } from "@/lib/i18n/server";
import { getConfig } from "@/lib/agentweb/settings";
import { getAnswer, listAnswers } from "@/lib/answer/service";
import { providerStatus } from "@/lib/answer/providers/status";
import { listResearch } from "@/lib/agentweb/research/store";
import { AskApp } from "@/components/ask/AskApp";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t("askApp.title")} — ShapesOS`, description: t("askApp.subtitle") };
}

export default async function AskPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await getMembership(user.id, workspace.id);
  if (!membership) redirect("/dashboard");
  const sp = await searchParams;
  const answerId = typeof sp.answer === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(sp.answer) ? sp.answer : null;
  const researchId = typeof sp.research === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(sp.research) ? sp.research : null;
  const [history, config, initial, mySessions] = await Promise.all([
    listAnswers(workspace.id, user.id, 15),
    getConfig(workspace.id),
    answerId ? getAnswer(workspace.id, user.id, answerId) : Promise.resolve(null),
    listResearch(workspace.id, user.id),
  ]);
  // Only the member's own, open research sessions can take an answer.
  const mine = mySessions.filter((r) => r.owner && r.status === "open").map((r) => ({ id: r.id, title: r.title }));
  const attachTo = researchId ? (mine.find((r) => r.id === researchId) ?? null) : null;
  const providers = providerStatus();
  return (
    <AskApp
      history={history.map((h) => ({ id: h.id, question: h.question, status: h.status, mock: h.mock, createdAt: h.createdAt.toISOString() }))}
      initial={initial ? { id: initial.id, status: initial.status, payload: initial.payload, usage: { ...initial.usage, mock: initial.mock } } : null}
      config={config}
      providers={providers}
      canAct={roleAtLeast(membership.role, "editor")}
      isAdmin={roleAtLeast(membership.role, "admin")}
      showCosts={process.env.NODE_ENV !== "production"}
      research={{ attachTo, mine }}
    />
  );
}
