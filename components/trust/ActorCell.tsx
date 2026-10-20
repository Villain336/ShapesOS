// ShapesOS — Phase 18.3 (WS=trust): who did it — a person, an agent or the
// system. Neutral icons (status colours are for agent STATES only); agents
// carry their black monogram tile like everywhere else.

import { Cog, UserRound } from "lucide-react";
import { AgentAvatar } from "@/components/aos/AgentAvatar";

export function ActorCell({ kind, label, kindLabel }: { kind: "person" | "agent" | "system"; label: string; kindLabel: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      {kind === "agent" ? (
        <AgentAvatar name={label} size="sm" />
      ) : kind === "person" ? (
        <UserRound size={16} className="shrink-0 text-muted" aria-hidden />
      ) : (
        <Cog size={16} className="shrink-0 text-muted" aria-hidden />
      )}
      <span className="min-w-0">
        <span className="block truncate font-medium text-ink">{label}</span>
        <span className="block text-xs text-muted">{kindLabel}</span>
      </span>
    </span>
  );
}
