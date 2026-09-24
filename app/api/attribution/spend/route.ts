// Marketr — Attribution API: manual spend entry (list + create).
// GET  /api/attribution/spend?channel=&from=&to=
// POST /api/attribution/spend (editor+) → { channel, campaign?, amountCents,
//   periodStart, periodEnd, notes? }

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { listSpend, createSpend, SpendInputSchema } from "@/lib/attribution/spend";

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);

  const sp = new URL(req.url).searchParams;
  const parseDate = (v: string | null) => {
    if (!v) return undefined;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };
  const spend = await listSpend(workspace.id, {
    channel: sp.get("channel") ?? undefined,
    from: parseDate(sp.get("from")),
    to: parseDate(sp.get("to")),
  });
  return Response.json({ spend });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();

  let body: unknown;
  try { body = await req.json(); } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = SpendInputSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }
  const spend = await createSpend(workspace.id, parsed.data);
  return Response.json({ spend }, { status: 201 });
}
