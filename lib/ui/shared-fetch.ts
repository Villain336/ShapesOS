// ShapesOS — one in-flight GET per URL, shared by every component that asks.
//
// The app shell mounts several pollers of the same endpoint at once (the
// sidebar, the top bar and the command bar all read /api/approvals/count; the
// notification bell is mounted in both the top bar and the mobile nav). Each
// used to fetch on its own, so one page load cost 4–8 identical API reads and
// a quick browse could hit the per-user read rate limit. sharedJson() joins
// concurrent callers onto one request and reuses a fresh result for a few
// seconds; an explicit refresh (after the user decides or reads something)
// passes { fresh: true } to skip the reuse window.

interface Entry {
  at: number;
  promise: Promise<SharedResult>;
}

export interface SharedResult {
  ok: boolean;
  status: number;
  body: unknown;
}

const DEFAULT_MAX_AGE_MS = 5_000;
const entries = new Map<string, Entry>();

export async function sharedJson(
  url: string,
  opts: { maxAgeMs?: number; fresh?: boolean; now?: () => number; fetcher?: typeof fetch } = {},
): Promise<SharedResult> {
  const now = (opts.now ?? Date.now)();
  const maxAge = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const hit = entries.get(url);
  if (hit && !opts.fresh && now - hit.at < maxAge) return hit.promise;
  const doFetch = opts.fetcher ?? fetch;
  const promise = (async (): Promise<SharedResult> => {
    const res = await doFetch(url, { cache: "no-store" });
    const body = res.ok ? await res.json().catch(() => null) : null;
    return { ok: res.ok, status: res.status, body };
  })();
  entries.set(url, { at: now, promise });
  // A failed request is never reused: the next caller tries again.
  promise.catch(() => entries.delete(url));
  void promise.then((r) => {
    if (!r.ok && entries.get(url)?.promise === promise) entries.delete(url);
  });
  return promise;
}

/** Forget a URL's shared result (tests; or after a write that changes it). */
export function invalidateShared(url?: string): void {
  if (url) entries.delete(url);
  else entries.clear();
}
