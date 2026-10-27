// Harness stub for src/session-context: only the part DocsScreen reads.
export function useSession() {
  return { gate: { baseUrl: "https://harness.test", authHeaders: () => ({ Cookie: "harness=1" }) } };
}
