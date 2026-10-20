// ShapesOS — Phase 18.2 (WS=comms): Messages — the pure rules.
//
//   mentions   "@Ana", "@ana.garcia", "@Researcher" → member keys
//              ("user:<id>", "agent:<key>"). A handle is a person's name
//              without spaces, their first name (only when no one else
//              shares it), their email's local part, or an agent's name / key.
//              An "@" inside a word (an email address) is never a mention.
//   DMs        one conversation per SET of people (and agents): the sorted
//              member keys joined with "|".
//   presence   active (seen in the last 2 minutes), away (the last 30),
//              offline; "focus" while the person is in a focus session —
//              their status says so and nothing pings them (the producers
//              hold notifications under focus).
//   names      channel names: lower case, words joined by "-", at most 60.

export type MemberKey = `user:${string}` | `agent:${string}`;

export interface MentionTarget {
  key: MemberKey;
  /** Handles that resolve to this member (lower case, no "@"). */
  handles: string[];
  /** What the UI shows after "@". */
  label: string;
  kind: "user" | "agent";
}

export function userKey(userId: string): MemberKey {
  return `user:${userId}`;
}

export function agentMemberKey(agentKey: string): MemberKey {
  return `agent:${agentKey}`;
}

export function parseMemberKey(key: string): { kind: "user" | "agent"; id: string } | null {
  const m = /^(user|agent):(.+)$/.exec(key);
  return m ? { kind: m[1] as "user" | "agent", id: m[2]! } : null;
}

/** "Ana María García" → "anamariagarcia" (accents folded; letters and digits only). */
export function handleOf(text: string | null | undefined): string | null {
  if (!text) return null;
  const h = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "")
    .replace(/^[._-]+|[._-]+$/g, "");
  return h || null;
}

/**
 * Mention targets for a workspace: its members and its agents. A first-name
 * handle is only offered when it is unambiguous (no two people share it, and
 * no agent is called that).
 */
export function buildMentionTargets(
  members: readonly { userId: string; name: string | null; email: string | null }[],
  agents: readonly { key: string; name: string }[],
): MentionTarget[] {
  const out: MentionTarget[] = [];
  const firstNames = new Map<string, number>();
  for (const m of members) {
    const first = handleOf((m.name ?? "").trim().split(/\s+/)[0]);
    if (first) firstNames.set(first, (firstNames.get(first) ?? 0) + 1);
  }
  const agentHandles = new Set<string>();
  for (const a of agents) {
    for (const h of [handleOf(a.name), handleOf(a.key)]) if (h) agentHandles.add(h);
  }
  for (const a of agents) {
    const handles = [...new Set([handleOf(a.name), handleOf(a.key)].filter((h): h is string => !!h))];
    out.push({ key: agentMemberKey(a.key), handles, label: a.name, kind: "agent" });
  }
  for (const m of members) {
    const handles = new Set<string>();
    const full = handleOf((m.name ?? "").replace(/\s+/g, ""));
    if (full && !agentHandles.has(full)) handles.add(full);
    const first = handleOf((m.name ?? "").trim().split(/\s+/)[0]);
    if (first && firstNames.get(first) === 1 && !agentHandles.has(first)) handles.add(first);
    const local = handleOf(m.email ? m.email.split("@")[0] : null);
    if (local && !agentHandles.has(local)) handles.add(local);
    const label = (m.name ?? "").trim() || (m.email ? m.email.split("@")[0]! : "member");
    out.push({ key: userKey(m.userId), handles: [...handles], label, kind: "user" });
  }
  return out;
}

// "@" at the start or after a space / opening punctuation (never inside a
// word, so an email address is not a mention), then a handle.
const MENTION_RE = /(^|[\s([{"'“‘>])@([\p{L}\p{N}][\p{L}\p{N}._-]*)/gu;

export interface MentionSegment {
  text: string;
  /** Set on a resolved mention. */
  key?: MemberKey;
  kind?: "user" | "agent";
}

function lookup(targets: readonly MentionTarget[]): Map<string, MentionTarget> {
  const map = new Map<string, MentionTarget>();
  for (const t of targets) for (const h of t.handles) if (!map.has(h)) map.set(h, t);
  return map;
}

/** Resolve one raw handle; trailing "." / "-" / "_" (sentence punctuation) is not part of it. */
function resolve(raw: string, map: Map<string, MentionTarget>): { target: MentionTarget; used: string } | null {
  const used = raw.replace(/[._-]+$/, "");
  const key = handleOf(used);
  const target = key ? map.get(key) : undefined;
  return target ? { target, used } : null;
}

/** The members a message mentions, in order of first appearance (unique). */
export function parseMentions(body: string, targets: readonly MentionTarget[]): MemberKey[] {
  const map = lookup(targets);
  const out: MemberKey[] = [];
  for (const m of body.matchAll(MENTION_RE)) {
    const r = resolve(m[2]!, map);
    if (r && !out.includes(r.target.key)) out.push(r.target.key);
  }
  return out;
}

/** A message split into text and mention segments (for highlighting). */
export function mentionSegments(body: string, targets: readonly MentionTarget[]): MentionSegment[] {
  const map = lookup(targets);
  const segs: MentionSegment[] = [];
  let last = 0;
  for (const m of body.matchAll(MENTION_RE)) {
    const r = resolve(m[2]!, map);
    if (!r) continue;
    const start = m.index! + m[1]!.length;
    const end = start + 1 + r.used.length;
    if (start > last) segs.push({ text: body.slice(last, start) });
    segs.push({ text: body.slice(start, end), key: r.target.key, kind: r.target.kind });
    last = end;
  }
  if (last < body.length) segs.push({ text: body.slice(last) });
  return segs.length ? segs : [{ text: body }];
}

/** The DM key for a set of members: sorted, unique, joined with "|". */
export function dmKeyFor(keys: readonly string[]): string {
  return [...new Set(keys)].sort().join("|");
}

export const PRESENCE_ACTIVE_MS = 2 * 60_000;
export const PRESENCE_AWAY_MS = 30 * 60_000;
/** How often an open Messages app says "still here". */
export const PRESENCE_HEARTBEAT_MS = 60_000;

export type PresenceStatus = "active" | "away" | "offline" | "focus";

export function presenceStatus(lastSeenAt: Date | null | undefined, now: Date, inFocus = false): PresenceStatus {
  if (inFocus) return "focus";
  if (!lastSeenAt) return "offline";
  const age = now.getTime() - lastSeenAt.getTime();
  if (age <= PRESENCE_ACTIVE_MS) return "active";
  if (age <= PRESENCE_AWAY_MS) return "away";
  return "offline";
}

/** "Product launch!" → "product-launch"; null when nothing usable is left. */
export function channelName(raw: string | null | undefined): string | null {
  const s = (raw ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/^#+/, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return s || null;
}

export const MAX_MESSAGE_CHARS = 4000;
/** Agents a single message may start (a message naming five agents starts the first two). */
export const MAX_AGENTS_PER_MESSAGE = 2;

/**
 * The SSE cursor: the newest change seen (ISO). A poll asks for changes
 * after cursor − overlap (instances' clocks and commit order differ a
 * little), and the stream drops what it already sent (id + version).
 */
export const STREAM_OVERLAP_MS = 5_000;

/** A message's version for the stream's de-duplication: edits AND new replies move it. */
export function messageVersion(m: { id: string; createdAt: Date | string; editedAt?: Date | string | null; replyCount?: number }): string {
  const t = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : 0);
  return `${m.id}@${Math.max(t(m.createdAt), t(m.editedAt))}#${m.replyCount ?? 0}`;
}
