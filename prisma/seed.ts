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

  // Milestone 12: default "Marketr" brand kit + starter ranking-report template.
  let brandKit = await prisma.brandKit.findFirst({
    where: { workspaceId: workspace.id, isDefault: true },
  });
  if (!brandKit) {
    brandKit = await prisma.brandKit.create({
      data: {
        workspaceId: workspace.id,
        name: "Marketr",
        colors: {
          primary: "#18181b",
          secondary: "#3f3f46",
          accent: "#f97316",
          text: "#18181b",
          muted: "#71717a",
        },
        fonts: { heading: "Helvetica-Bold", body: "Helvetica" },
        tone: "Confident, plain-spoken, no jargon. Lead with the numbers.",
        isDefault: true,
      },
    });
    console.log(`Seeded default brand kit "${brandKit.name}".`);
  }

  const existingTemplate = await prisma.reportTemplate.findFirst({
    where: { workspaceId: workspace.id, name: "Monthly SEO Report" },
  });
  if (!existingTemplate) {
    await prisma.reportTemplate.create({
      data: {
        workspaceId: workspace.id,
        name: "Monthly SEO Report",
        type: "ranking",
        brandKitId: brandKit.id,
        projectId: project.id,
        schedule: "manual",
        content: {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 1 },
              content: [{ type: "text", text: "SEO Performance Report" }],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Performance summary for {{project_domain}} — {{period}}. Prepared by {{brand_name}}.",
                },
              ],
            },
            {
              type: "heading",
              attrs: { level: 2 },
              content: [{ type: "text", text: "At a glance" }],
            },
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Tracking {{tracked_count}} keywords; average position {{avg_position}}." }],
                    },
                  ],
                },
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "{{improved_count}} keywords improved, {{declined_count}} declined." }],
                    },
                  ],
                },
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Appearing in {{ai_overview_count}} AI Overviews." }],
                    },
                  ],
                },
              ],
            },
            {
              type: "heading",
              attrs: { level: 2 },
              content: [{ type: "text", text: "Keyword rankings" }],
            },
            { type: "paragraph", content: [{ type: "text", text: "{{rankings_table}}" }] },
            { type: "horizontalRule" },
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  marks: [{ type: "italic" }],
                  text: "Questions about this report? Reply to this email — we read everything.",
                },
              ],
            },
          ],
        },
      },
    });
    console.log(`Seeded starter template "Monthly SEO Report".`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
