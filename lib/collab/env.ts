// ShapesOS — Phase 18.2 (WS=content): where the collab server listens (PURE).
//   COLLAB_PORT  the worker process starts the collab server on this port
//                (local + docker compose); unset = the worker doesn't.
//   PORT         the standalone collab service (scripts/collab.mts) on a
//                platform that assigns the port (Render web service).
// The browser connects to COLLAB_PUBLIC_URL (lib/collab/token.ts).

type Env = Record<string, string | undefined>;

function port(v: string | undefined): number | null {
  const n = Number((v ?? "").trim());
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/** The worker's collab port, or null when the worker shouldn't run collab. */
export function workerCollabPort(env: Env = process.env): number | null {
  return port(env.COLLAB_PORT);
}

/** The standalone collab service's port: COLLAB_PORT, else PORT, else 1235. */
export function standaloneCollabPort(env: Env = process.env): number {
  return port(env.COLLAB_PORT) ?? port(env.PORT) ?? 1235;
}
