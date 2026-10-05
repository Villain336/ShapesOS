// ShapesOS mobile — configurable server URL (self-hosted installs).
import { describe, expect, it, vi } from "vitest";

vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: { apiBaseUrl: "https://from-config.example.com/" } } } }));

const {
  FALLBACK_BASE_URL,
  MemoryServerUrlStore,
  isPrivateHost,
  normalizeServerUrl,
  probeServer,
  resolveDefaultBaseUrl,
  resolveServerUrl,
} = await import("../src/config");

describe("normalizeServerUrl", () => {
  it("accepts https anywhere and adds https:// to a bare host", () => {
    expect(normalizeServerUrl("shapes.example.com")).toEqual({ ok: true, url: "https://shapes.example.com", insecure: false });
    expect(normalizeServerUrl(" https://shapes.example.com/ ")).toEqual({ ok: true, url: "https://shapes.example.com", insecure: false });
    expect(normalizeServerUrl("https://example.com:8443/shapes//")).toEqual({ ok: true, url: "https://example.com:8443/shapes", insecure: false });
  });
  it("allows http only on private networks", () => {
    expect(normalizeServerUrl("http://192.168.1.10:3000")).toEqual({ ok: true, url: "http://192.168.1.10:3000", insecure: true });
    expect(normalizeServerUrl("http://localhost:3000").ok).toBe(true);
    expect(normalizeServerUrl("http://shapes.local").ok).toBe(true);
    const pub = normalizeServerUrl("http://shapes.example.com");
    expect(pub.ok).toBe(false);
  });
  it("refuses junk, other schemes, credentials, query and fragment", () => {
    for (const bad of ["", "   ", "ftp://x.example.com", "https://user:pw@x.example.com", "https://x.example.com/?a=1", "https://x.example.com/#f", "javascript:alert(1)"]) {
      expect(normalizeServerUrl(bad).ok, bad).toBe(false);
    }
  });
});

describe("isPrivateHost", () => {
  it("knows the private ranges", () => {
    for (const h of ["localhost", "127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.1", "192.168.0.2", "10.0.2.2", "box.local"]) {
      expect(isPrivateHost(h), h).toBe(true);
    }
    for (const h of ["172.32.0.1", "8.8.8.8", "example.com", "192.169.0.1"]) expect(isPrivateHost(h), h).toBe(false);
  });
});

describe("resolution order", () => {
  it("build default: env, then app config, then localhost", () => {
    expect(resolveDefaultBaseUrl({ EXPO_PUBLIC_API_BASE_URL: "https://env.example.com/" }, { apiBaseUrl: "https://cfg.example.com" })).toBe(
      "https://env.example.com",
    );
    expect(resolveDefaultBaseUrl({}, { apiBaseUrl: "https://cfg.example.com" })).toBe("https://cfg.example.com");
    expect(resolveDefaultBaseUrl({}, {})).toBe(FALLBACK_BASE_URL);
    expect(resolveDefaultBaseUrl({ EXPO_PUBLIC_API_BASE_URL: "http://public.example.com" }, {})).toBe(FALLBACK_BASE_URL);
  });
  it("the in-app setting wins when valid", async () => {
    const store = new MemoryServerUrlStore();
    expect(await resolveServerUrl(store, "https://default.example.com")).toBe("https://default.example.com");
    await store.set("https://mine.example.com");
    expect(await resolveServerUrl(store, "https://default.example.com")).toBe("https://mine.example.com");
    await store.set("http://not-private.example.com");
    expect(await resolveServerUrl(store, "https://default.example.com")).toBe("https://default.example.com");
  });
});

describe("probeServer", () => {
  it("hits the liveness endpoint", async () => {
    const seen: string[] = [];
    const ok = await probeServer("https://x.example.com", (async (u: RequestInfo | URL) => {
      seen.push(String(u));
      return new Response("{}", { status: 200 });
    }) as typeof fetch);
    expect(ok).toEqual({ ok: true });
    expect(seen).toEqual(["https://x.example.com/api/health/live"]);
  });
  it("explains a non-ShapesOS answer and a network failure", async () => {
    const bad = await probeServer("https://x.example.com", (async () => new Response("", { status: 404 })) as typeof fetch);
    expect(bad.ok).toBe(false);
    const down = await probeServer("https://x.example.com", (async () => {
      throw new TypeError("Network request failed");
    }) as typeof fetch);
    expect(down).toEqual({ ok: false, error: expect.stringMatching(/Couldn't reach/) });
  });
});
