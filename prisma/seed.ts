// Marketr — demo seed. Run with `npm run db:seed` (needs a live DATABASE_URL).
// Creates a demo workspace + project + sample keywords for the in-house beta.

import { prisma } from "../lib/prisma";

async function main() {
  let workspace = await prisma.workspace.findFirst({
    where: { ownerUserId: "demo-admin" },
  });
  if (!workspace) {
    workspace = await prisma.workspace.create({
      data: {
        name: "Demo workspace",
        ownerUserId: "demo-admin",
        plan: "self_hosted",
      },
    });
  }

  let project = await prisma.project.findFirst({
    where: { workspaceId: workspace.id, domain: "example.com" },
  });
  if (!project) {
    project = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        domain: "example.com",
        locale: "en-US",
      },
    });
  }

  const seeds = [
    { phrase: "senior living greensboro nc", volume: 880, difficulty: 34, cpc: 4.2, intent: "commercial" as const },
    { phrase: "assisted living raleigh cost", volume: 720, difficulty: 41, cpc: 6.8, intent: "commercial" as const },
    { phrase: "how to choose memory care facility", volume: 480, difficulty: 22, cpc: 3.1, intent: "informational" as const },
    { phrase: "best home care agencies charlotte", volume: 390, difficulty: 38, cpc: 5.5, intent: "commercial" as const },
    { phrase: "medicaid assisted living north carolina", volume: 260, difficulty: 18, cpc: 2.4, intent: "informational" as const },
  ];

  for (const s of seeds) {
    await prisma.keyword.upsert({
      where: { projectId_phrase: { projectId: project.id, phrase: s.phrase } },
      update: { tracked: true },
      create: { ...s, projectId: project.id, list: "Demo list", tracked: true },
    });
  }

  console.log(`Seeded workspace "${workspace.name}" → project ${project.domain} with ${seeds.length} keywords.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
