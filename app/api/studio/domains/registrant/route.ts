// Marketr — studio API: registrant contact for domain purchases (milestone 22).
// GET /api/studio/domains/registrant?projectId=
// PUT /api/studio/domains/registrant { projectId, ...fields } (owner/admin)

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { ICANN_DISCLOSURE, getRegistrant, saveRegistrant } from "@/lib/studio/service";
import { ownedProject, readJson, requireOwnerAdmin } from "../../_lib";

function serialize(r: Awaited<ReturnType<typeof getRegistrant>>) {
  if (!r) return null;
  return {
    firstName: r.firstName,
    lastName: r.lastName,
    email: r.email,
    phone: r.phone,
    address: r.address,
    city: r.city,
    state: r.state,
    zip: r.zip,
    country: r.country,
  };
}

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const project = await ownedProject(user.id, new URL(req.url).searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const row = await getRegistrant(prisma, project.workspaceId);
  return Response.json({ registrant: serialize(row), icannDisclosure: ICANN_DISCLOSURE });
}

export async function PUT(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readJson(req);
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireOwnerAdmin(user.id, project.id);
  if (denied) return denied;
  try {
    const row = await saveRegistrant(
      prisma,
      project.workspaceId,
      {
        firstName: String(body.firstName ?? ""),
        lastName: String(body.lastName ?? ""),
        email: String(body.email ?? ""),
        phone: String(body.phone ?? ""),
        address: String(body.address ?? ""),
        city: String(body.city ?? ""),
        state: String(body.state ?? ""),
        zip: String(body.zip ?? ""),
        country: String(body.country ?? "US"),
      },
      "user",
    );
    return Response.json({ registrant: serialize(row) });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to save registrant." },
      { status: 400 },
    );
  }
}
