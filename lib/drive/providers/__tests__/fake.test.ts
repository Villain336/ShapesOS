// ShapesOS — Phase 21B (WS=drive): the in-memory FAKE provider passes the contract suite.
// Run: npx tsx --test lib/drive/providers/__tests__/fake.test.ts
import { InMemoryFakeProvider } from "../fake";
import { runProviderContract } from "./contract-suite";

runProviderContract("fake (in-memory, a mock)", async () => ({ provider: new InMemoryFakeProvider(5_000_000), sampleText: (s) => Buffer.from(s, "utf8") }), { supportsQuotaLimit: true });
