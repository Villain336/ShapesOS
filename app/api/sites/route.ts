// Marketr — site connection management API (milestone 6).
// GET  /api/sites?projectId=…                    → { connections } (no secrets)
// POST /api/sites { projectId, demo: true }      → demo/mock connection
// POST /api/sites { projectId, label, host, port, username, authType, secret }
// DELETE /api/sites/[id]?projectId=…

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { encryptSecret, secretHint } from "@/lib/sitefiles/crypto";
import { publicConnection } from "@/lib/sitefiles";
import { ownedConnection, ownedProject, readJsonBody } from "@/lib/sitefiles/api";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const project = await ownedProject(
    user.id,
    req.nextUrl.searchParams.get("projectId"),
  );
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  const connections = await prisma.siteConnection.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: "asc" },
  });
  return Response.json({ connections: connections.map(publicConnection) });
}

interface CreateBody {
  projectId?: string;
  demo?: boolean;
  label?: string;
  host?: string;
  port?: number;
  username?: string;
  authType?: "password" | "key";
  secret?: string;
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = await readJsonBody<CreateBody>(req);
  if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });

  const project = await ownedProject(user.id, body.projectId);
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  if (body.demo) {
    const connection = await prisma.siteConnection.create({
      data: {
        projectId: project.id,
        label: "Demo site (mock)",
        host: "demo",
        port: 22,
        username: "demo",
        authType: "password",
        secretEnc: "demo",
        demo: true,
      },
    });
    return Response.json({ connection: publicConnection(connection) }, { status: 201 });
  }

  const label = (body.label ?? "").trim();
  const host = (body.host ?? "").trim().toLowerCase();
  const username = (body.username ?? "").trim();
  const secret = body.secret ?? "";
  const port = Number.isInteger(body.port) ? (body.port as number) : 22;
  const authType = body.authType === "key" ? "key" : "password";

  if (!label) return Response.json({ error: "Label is required" }, { status: 400 });
  if (!host || host.includes("/") || host.includes(" ")) {
    return Response.json({ error: "Enter a valid host, e.g. example.com" }, { status: 400 });
  }
  if (port < 1 || port > 65535) {
    return Response.json({ error: "Port must be 1–65535" }, { status: 400 });
  }
  if (!username) return Response.json({ error: "Username is required" }, { status: 400 });
  if (!secret) {
    return Response.json(
      { error: authType === "key" ? "Paste the private key" : "Password is required" },
      { status: 400 },
    );
  }

  let secretEnc: string;
  try {
    secretEnc = encryptSecret(secret);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Encryption failed" },
      { status: 500 },
    );
  }

  const connection = await prisma.siteConnection.create({
    data: {
      projectId: project.id,
      label,
      host,
      port,
      username,
      authType,
      secretEnc,
      secretHint: secretHint(secret),
      demo: false,
    },
  });
  return Response.json({ connection: publicConnection(connection) }, { status: 201 });
}
