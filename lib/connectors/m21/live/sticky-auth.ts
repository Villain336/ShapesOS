// ShapesOS — Phase 11 (devtools): a TokenSource that remembers a refresh.
//
// liveRequest refreshes once on 401 and retries with the new token, but only
// inside that one request. Clients that make several requests per tool call
// (Jira site lookup + call, Airtable/Linear pagination) wrap the source so a
// token refreshed by the first request is used by the next ones — the vault
// refresher is one-shot per invocation, so a stale token would otherwise end
// in auth_rejected on the second request.

import type { TokenSource } from "./http";

export function stickyAuth(auth: TokenSource): TokenSource {
  const source: TokenSource = { token: auth.token };
  if (auth.refresh) {
    const refresh = auth.refresh;
    source.refresh = async () => {
      const next = await refresh();
      if (next) source.token = next;
      return next;
    };
  }
  return source;
}
