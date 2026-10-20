// ShapesOS — Phase 21B (WS=drive): the Files app's calls to the Drive API (client).

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function readError(res: Response, fallback: string): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
  return new ApiError(body?.error ?? fallback, res.status, body?.code);
}

export async function getJson<T>(url: string, fallback = "That didn't work."): Promise<T> {
  const res = await fetch(url, { cache: "no-store" }).catch(() => null);
  if (!res) throw new ApiError(fallback, 0);
  if (!res.ok) throw await readError(res, fallback);
  return (await res.json()) as T;
}

export async function postJson<T>(url: string, body: unknown, fallback = "That didn't work."): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  if (!res) throw new ApiError(fallback, 0);
  if (!res.ok) throw await readError(res, fallback);
  return (await res.json()) as T;
}

export const treeUrl = (workspaceId: string, view: string, params: Record<string, string | number | undefined> = {}): string => {
  const q = new URLSearchParams({ workspaceId, view });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  return `/api/drive/tree?${q.toString()}`;
};

export const downloadUrl = (workspaceId: string, fileId: string): string => `/api/files/${encodeURIComponent(fileId)}?workspaceId=${encodeURIComponent(workspaceId)}&download=1`;
