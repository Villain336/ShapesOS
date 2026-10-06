// ShapesOS — Phase 19A (WS=server): GET /api/desktop/releases?channel=stable|beta
// → { configured, channel, version, releaseDate, files: [{ os, arch, url, size, sha512 }] }.
// Public and read-only (the website's /download page reads it, like the
// public /pricing page reads plan constants): it only re-publishes what the
// public update bucket (DESKTOP_UPDATE_URL) already serves. No URL →
// configured: false. Cached 5 minutes in-process.

import { DESKTOP_CHANNELS, desktopReleases, type DesktopChannel } from "@/lib/desktop-app/releases";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("channel") ?? "stable";
  const channel: DesktopChannel = (DESKTOP_CHANNELS as readonly string[]).includes(q) ? (q as DesktopChannel) : "stable";
  const data = await desktopReleases(channel);
  return Response.json(data, { headers: { "Cache-Control": "public, max-age=300" } });
}
