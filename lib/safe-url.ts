// Marketr — SSRF-safe URL validation (day-1 hardening, M6).
//
// assertSafeUrl() is the central gate for operator-supplied URLs that the
// server will fetch (WordPress baseUrl today; reuse for any future fetch of
// a user-supplied URL). It fails closed:
//   - requires an absolute http(s) URL,
//   - rejects credentials embedded in the URL,
//   - resolves the hostname and rejects loopback, private (RFC1918),
//     link-local (covers 169.254.169.254), multicast, reserved and
//     unspecified addresses, for both IPv4 and IPv6,
//   - explicitly blocks well-known cloud metadata hostnames,
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
import { isIP } from "node:net";

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
  "instance-data",
]);

function ipv4Blocked(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 10) return true; // RFC1918 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16.0.0/12
  if (a === 192 && b === 168) return true; // RFC1918 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16 (cloud metadata)
  if (a === 0) return true; // 0.0.0.0/8 (unspecified)
  if (a >= 224 && a <= 239) return true; // multicast 224.0.0.0/4
  if (a >= 240) return true; // reserved 240.0.0.0/4
  return false;
}

function ipv6Blocked(ip: string): boolean {
  const n = ip.toLowerCase();
  if (n === "::1" || n === "0:0:0:0:0:0:0:1") return true; // loopback
  if (n === "::" || n === "0:0:0:0:0:0:0:0") return true; // unspecified
  // Link-local fe80::/10: the first 10 bits are 1111111010, so the first
  // hextet ranges from fe80 to febf (not just fe80:).
  const first = n.split(":")[0] ?? "";
  if (/^fe[89ab][0-9a-f]$/i.test(first)) return true; // fe80::/10
  if (n.startsWith("fec0:")) return true; // site-local (deprecated)
  if (n.startsWith("fc") || n.startsWith("fd")) return true; // unique-local fc00::/7
  if (n.startsWith("ff")) return true; // multicast ff00::/8
  // IPv4-mapped IPv6: check the embedded v4 address.
  const m = n.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m && ipv4Blocked(m[1])) return true;
  return false;
}

function addressBlocked(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) return ipv4Blocked(addr);
  if (v === 6) return ipv6Blocked(addr);
  return true; // unparseable → fail closed
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
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) throw new UnsafeUrlError("URL must include a hostname.");
  if (METADATA_HOSTS.has(host)) {
    throw new UnsafeUrlError("URL host is not allowed.");
  }
  // Literal IP hostnames: check directly (covers hex/octal/decimal forms
  // that URL parsing normalizes).
  if (isIP(host)) {
    if (addressBlocked(host)) throw new UnsafeUrlError("URL resolves to a disallowed address.");
  } else {
    // Resolve and check every address (also defeats decimal-IP tricks,
    // since getaddrinfo resolves "2130706433" to 127.0.0.1).
    let addrs: string[];
    try {
      addrs = await resolve(host);
    } catch {
      throw new UnsafeUrlError("Could not resolve URL hostname.");
    }
    if (addrs.length === 0 || addrs.some(addressBlocked)) {
      throw new UnsafeUrlError("URL resolves to a disallowed address.");
    }
  }
  return url.toString().replace(/\/+$/, "");
}
