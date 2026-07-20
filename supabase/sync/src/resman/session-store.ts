/**
 * ResManSessionStore — persist the cookie jar between cron runs. Port of
 * KrakenCore/Services/ResMan/ResManSessionStore.swift, adapted per design §3.1:
 * the Swift store wrote to the Keychain; there is no Keychain in Node, so the
 * cookies are serialized to a pluggable backend (in production, a
 * `resman_sync_state.cursor` entry / Supabase KV row keyed for the worker). The
 * save/load/clear shape and the StoredCookie round-trip match the source.
 */

import { CookieJar, type StoredCookie } from "./cookies";

/** Pluggable persistence backend (async so a DB/KV row can back it). */
export interface SessionStorageBackend {
  read(key: string): Promise<string | null> | string | null;
  write(key: string, value: string): Promise<void> | void;
  remove(key: string): Promise<void> | void;
}

/** Default in-memory backend — used in tests and as a same-process cache. */
export class InMemorySessionStorage implements SessionStorageBackend {
  private readonly store = new Map<string, string>();

  read(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  write(key: string, value: string): void {
    this.store.set(key, value);
  }

  remove(key: string): void {
    this.store.delete(key);
  }
}

export class ResManSessionStore {
  static readonly defaultCookieKey = "resman.sessionCookies";

  private readonly backend: SessionStorageBackend;
  private readonly key: string;

  constructor(
    backend: SessionStorageBackend = new InMemorySessionStorage(),
    key: string = ResManSessionStore.defaultCookieKey,
  ) {
    this.backend = backend;
    this.key = key;
  }

  /** Persist the jar's cookies. */
  async save(jar: CookieJar, log: (message: string) => void = () => {}): Promise<void> {
    const stored = jar.serialize();
    await this.backend.write(this.key, JSON.stringify(stored));
    log(`[session] saved ${stored.length} cookies`);
  }

  /** Restore cookies into the jar. A missing session is a no-op. */
  async load(jar: CookieJar, log: (message: string) => void = () => {}): Promise<void> {
    const raw = await this.backend.read(this.key);
    if (!raw) {
      log("[session] no saved session found");
      return;
    }
    let stored: StoredCookie[];
    try {
      stored = JSON.parse(raw) as StoredCookie[];
    } catch {
      log("[session] stored session was unreadable — ignoring");
      return;
    }
    jar.load(stored);
    log(`[session] loaded ${stored.length} cookies`);
  }

  /** Remove the persisted session and empty the jar. */
  async clear(jar: CookieJar, log: (message: string) => void = () => {}): Promise<void> {
    await this.backend.remove(this.key);
    jar.clear();
    log("[session] session cleared");
  }
}
