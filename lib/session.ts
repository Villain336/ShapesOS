// Marketr — session + workspace helpers.
// A signed-in user always has exactly one workspace in milestone 2
// (multi-workspace switching comes later). It is auto-provisioned on
// first login so the product is usable immediately.

import { auth } from "@/auth";
import { prisma } from "./prisma";

export async function requireUser() {
  const session = await auth();
  if (!session?.user?.id) return null;
  return session.user;
}

export async function getOrCreateWorkspace(
  userId: string,
  email?: string | null,
) {
  const existing = await prisma.workspace.findFirst({
    where: { ownerUserId: userId },
  });
  if (existing) return existing;
  return prisma.workspace.create({
    data: {
      name: email ? `${email}'s workspace` : "My workspace",
      ownerUserId: userId,
      plan: "self_hosted",
    },
  });
}
