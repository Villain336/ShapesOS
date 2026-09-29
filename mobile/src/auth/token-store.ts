// Marketr mobile — session-token storage.
//
// The NextAuth session cookie is httpOnly: JavaScript (and React Native)
// cannot read document.cookie, and React Native has no cookie jar at all —
// so the app manages the session cookie explicitly:
//   login  → extract the cookie value from the Set-Cookie response header
//   store  → SecureStore (device keychain / keystore)
//   send   → attached as a `Cookie` header on every API call
//
// MemoryTokenStore is the fallback for tests and for platforms where
// SecureStore is unavailable. Anything stored here is the user's own
// session token, never a shared secret.

export interface TokenStore {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryTokenStore implements TokenStore {
  private value: string | null = null;
  async get(): Promise<string | null> {
    return this.value;
  }
  async set(value: string): Promise<void> {
    this.value = value;
  }
  async clear(): Promise<void> {
    this.value = null;
  }
}

const SECURE_STORE_KEY = "marketr.sessionToken.v1";

/** SecureStore-backed token store (lazy import keeps tests dependency-free). */
export function createSecureTokenStore(): TokenStore {
  let SecureStore: typeof import("expo-secure-store") | null = null;
  const load = async () => {
    if (!SecureStore) {
      try {
        SecureStore = await import("expo-secure-store");
      } catch {
        return null;
      }
    }
    return SecureStore;
  };
  return {
    async get() {
      const s = await load();
      if (!s) return null;
      try {
        return await s.getItemAsync(SECURE_STORE_KEY);
      } catch {
        return null;
      }
    },
    async set(value: string) {
      const s = await load();
      if (!s) return;
      await s.setItemAsync(SECURE_STORE_KEY, value, {
        keychainAccessible: (await import("expo-secure-store")).AFTER_FIRST_UNLOCK,
      });
    },
    async clear() {
      const s = await load();
      if (!s) return;
      await s.deleteItemAsync(SECURE_STORE_KEY);
    },
  };
}
