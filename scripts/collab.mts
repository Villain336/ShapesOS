// ShapesOS — Phase 18.2 (WS=content): the live-collaboration server, alone.
//
// Run: npx tsx scripts/collab.mts   (worker image; Render: shapesos-collab)
// Listens on COLLAB_PORT, else PORT (Render sets it), else 1235. Needs
// DATABASE_URL (the least-privilege app role) and AUTH_SECRET (the token key,
// shared with the web service). Exactly ONE instance: see lib/collab/server.ts.
// SIGTERM / SIGINT (lib/runtime/shutdown.ts): store every live document,
// close the connections (browsers reconnect to the next process), exit.

import { startCollabServer } from "@/lib/collab/server";
import { standaloneCollabPort } from "@/lib/collab/env";
import { prisma } from "@/lib/prisma";
import { installShutdownHandlers, onShutdown } from "@/lib/runtime/shutdown";

if (!(process.env.DATABASE_URL ?? "").trim()) {
  console.error("[collab] DATABASE_URL is not set; nothing to serve.");
  process.exit(1);
}

const handle = await startCollabServer({ port: standaloneCollabPort(), host: "0.0.0.0" });

onShutdown("collab", async (signal) => {
  console.log(`[collab] ${signal}: storing live documents and closing connections…`);
  await handle.close();
  await prisma.$disconnect().catch(() => undefined);
});
installShutdownHandlers();
