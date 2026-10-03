// Marketr — SSRF-safe URL validation (day-1 hardening, M6; Phase 1 ranges).
//
// assertSafeUrl() is the central gate for operator-supplied URLs that the
// server will fetch (WordPress baseUrl, dataset web ingest, competitor fleet,
// clipper URL sources, skill URL import, link verification, design render
// images, CTV landing checks). It fails closed:
//   - requires an absolute http(s) URL,
//   - rejects credentials embedded in the URL,
//   - resolves the hostname and rejects every non-global special-purpose
//     address (loopback, RFC1918, CGNAT, link-local incl. 169.254.169.254,
//     benchmarking, documentation, IETF protocol assignments, multicast,
//     reserved, unspecified) for IPv4 and IPv6 — including IPv6 forms that
//     embed an IPv4 address (mapped, compat, translated, NAT64, 6to4),
//   - explicitly blocks well-known cloud metadata hostnames and localhost,
//   - fails closed when DNS resolution itself fails.
//
// DNS-rebinding note: validation re-resolves on every request (see
// safeFetch in lib/connectors/safe-fetch.ts), so a hostname that flips to an
// internal address between requests is caught on the next call. The residual
// gap is a flip between the per-request lookup and TCP connect — inherent to
// fetch without a custom dialer. For this codebase's threat model
// (authenticated project admins configuring their own CMS) that is an
// accepted residual risk; a high-security deployment should pin the resolved
// IP with a custom dialer.

import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

/** DNS resolver returning all addresses for a hostname. Injectable for tests. */
export type ResolveFn = (host: string) => Promise<string[]>;

const defaultResolve: ResolveFn = async (host) =>
  (await lookup(host, { all: true })).map((r) => r.address);

const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.google.com",
  "metadata",
  "instance-data",
  "instance-data.ec2.internal",
]);

// ── Address classification ───────────────────────────────────────────────
//
// Ranges come from the IANA IPv4/IPv6 special-purpose address registries
// (everything not globally reachable). CIDR matching is node's
// net.BlockList, not hand-rolled octet maths. IPv6 addresses that EMBED an
// IPv4 address (IPv4-mapped ::ffff:0:0/96, IPv4-compatible ::/96,
// IPv4-translated ::ffff:0:0:0/96, NAT64 64:ff9b::/96, 6to4 2002::/16) are
// unwrapped and the embedded IPv4 address is checked as well, so
// [::ffff:7f00:1], [::ffff:a9fe:a9fe], [64:ff9b::a9fe:a9fe] and
// [2002:7f00:1::] are all refused.

const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC1918
  ["100.64.0.0", 10], // CGNAT (RFC 6598)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata 169.254.169.254)
  ["172.16.0.0", 12], // RFC1918
  ["192.0.0.0", 24], // IETF protocol assignments (incl. 192.0.0.192)
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.31.196.0", 24], // AS112-v4
  ["192.52.193.0", 24], // AMT
  ["192.88.99.0", 24], // 6to4 relay anycast (deprecated)
  ["192.168.0.0", 16], // RFC1918
  ["192.175.48.0", 24], // AS112 direct delegation
  ["198.18.0.0", 15], // benchmarking (RFC 2544)
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + limited broadcast
];

const V6_BLOCKED: Array<[string, number]> = [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b:1::", 48], // local-use NAT64 (RFC 8215)
  ["100::", 64], // discard-only
  ["2001::", 23], // IETF protocol assignments (incl. Teredo 2001::/32)
  ["2001:db8::", 32], // documentation
  ["3fff::", 20], // documentation (RFC 9637)
  ["5f00::", 16], // SRv6 SIDs
  ["fc00::", 7], // unique-local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
];

const blockList = new BlockList();
for (const [net, prefix] of V4_BLOCKED) blockList.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of V6_BLOCKED) blockList.addSubnet(net, prefix, "ipv6");

/** Expand an IPv6 literal (brackets/zone stripped, optional dotted-quad tail) to 8 hextets. */
export function parseIPv6(addr: string): number[] | null {
  let a = addr.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const pct = a.indexOf("%");
  if (pct >= 0) a = a.slice(0, pct);
  if (isIP(a) !== 6) return null;
  const dq = a.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dq) {
    const o = dq.slice(2, 6).map(Number);
    a = `${dq[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = a.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const parts = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (parts.length !== 8) return null;
  const out = parts.map((h) => parseInt(h, 16));
  return out.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? out : null;
}

function v4FromHextets(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** The IPv4 address an IPv6 address embeds (mapped/compat/translated/NAT64/6to4), if any. */
export function embeddedIPv4(addr: string): string | null {
  const h = parseIPv6(addr);
  if (!h) return null;
  const zero = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (deprecated compat)
  if (zero(0, 5) && (h[5] === 0xffff || h[5] === 0)) return v4FromHextets(h[6], h[7]);
  // ::ffff:0:a.b.c.d (IPv4-translated, RFC 2765)
  if (zero(0, 4) && h[4] === 0xffff && h[5] === 0) return v4FromHextets(h[6], h[7]);
  // 64:ff9b::a.b.c.d (well-known NAT64 prefix, RFC 6052)
  if (h[0] === 0x64 && h[1] === 0xff9b && zero(2, 6)) return v4FromHextets(h[6], h[7]);
  // 2002:AABB:CCDD::/48 (6to4, RFC 3056)
  if (h[0] === 0x2002) return v4FromHextets(h[1], h[2]);
  return null;
}

function ipv4Blocked(ip: string): boolean {
  if (isIP(ip) !== 4) return true; // only canonical dotted-quad; else fail closed
  return blockList.check(ip, "ipv4");
}

function ipv6Blocked(ip: string): boolean {
  const h = parseIPv6(ip);
  if (!h) return true;
  if (blockList.check(h.map((x) => x.toString(16)).join(":"), "ipv6")) return true;
  const v4 = embeddedIPv4(ip);
  return v4 !== null && ipv4Blocked(v4);
}

/**
 * True when the server must never connect to `addr` (an IPv4/IPv6 literal,
 * bracketed or zone-qualified IPv6 accepted). Non-IP input fails closed.
 */
export function isBlockedAddress(addr: string): boolean {
  const a = addr.trim().replace(/^\[|\]$/g, "");
  const bare = a.includes("%") ? a.slice(0, a.indexOf("%")) : a;
  const v = isIP(bare);
  if (v === 4) return ipv4Blocked(bare);
  if (v === 6) return ipv6Blocked(bare);
  return true;
}

/**
 * Validate that `raw` is safe for the server to fetch.
 * Returns the normalized URL string (trailing slashes trimmed).
 * Throws UnsafeUrlError when the URL is invalid or unsafe.
 *
 * `opts.resolve` injects the DNS resolver (tests use a fake; no network).
 * Every call re-resolves, so per-request validation also narrows the
 * DNS-rebinding window to the lookup→connect gap inherent to fetch.
 */
export async function assertSafeUrl(
  raw: unknown,
  opts?: { resolve?: ResolveFn },
): Promise<string> {
  const resolve = opts?.resolve ?? defaultResolve;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new UnsafeUrlError("A URL is required.");
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeUrlError("Invalid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError("Only http(s) URLs are allowed.");
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("Credentials must not be embedded in the URL.");
  }
  // WHATWG URL parsing already canonicalizes hex/octal/decimal IPv4 forms
  // ("0x7f.1", "2130706433" → 127.0.0.1) and compresses IPv6 literals
  // ("[::ffff:127.0.0.1]" → "[::ffff:7f00:1]"); trailing dots are stripped
  // so "metadata.google.internal." can't dodge the name check.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!host) throw new UnsafeUrlError("URL must include a hostname.");
  if (METADATA_HOSTS.has(host) || host === "localhost" || host.endsWith(".localhost")) {
    throw new UnsafeUrlError("URL host is not allowed.");
  }
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new UnsafeUrlError("URL resolves to a disallowed address.");
  } else {
    // Resolve and check every address (a single internal answer is enough
    // to refuse — the connect could land on any of them).
    let addrs: string[];
    try {
      addrs = await resolve(host);
    } catch {
      throw new UnsafeUrlError("Could not resolve URL hostname.");
    }
    if (addrs.length === 0 || addrs.some(isBlockedAddress)) {
      throw new UnsafeUrlError("URL resolves to a disallowed address.");
    }
  }
  return url.toString().replace(/\/+$/, "");
}
