/**
 * In-memory last-known-good snapshot of every client's config (TRD §5.2).
 *
 * Fallback mode has a hidden dependency: the local token bucket needs each
 * client's configured limit — but config lives in Redis (synced from
 * Postgres), i.e., exactly the store that is DOWN when fallback activates.
 * So during normal operation this snapshot refreshes periodically from
 * Redis, and during an outage fallback reads limits from memory, never from
 * the network. A refresh failure keeps the previous snapshot (stale beats
 * empty); only the age is reported so /health can surface staleness.
 */
import type Redis from 'ioredis';
import type { ClientConfig } from '../types';

const CONFIG_KEY_PATTERN = 'ratelimit:config:*';
const CONFIG_KEY_PREFIX = 'ratelimit:config:';

/** Parses a raw Redis config hash; returns null if malformed/incomplete. */
export function parseConfigHash(hash: Record<string, string>): ClientConfig | null {
  const limit = Number(hash.limit);
  const windowSeconds = Number(hash.windowSeconds);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) return null;
  return {
    limit,
    windowSeconds,
    // Unknown/missing policy degrades to fail-open — the PRD default.
    onOutage: hash.onOutage === 'closed' ? 'closed' : 'open',
  };
}

/** Strips the key prefix and hash-tag braces: "…:{client-a}" → "client-a". */
export function clientIdFromKey(key: string): string {
  const raw = key.slice(CONFIG_KEY_PREFIX.length);
  return raw.startsWith('{') && raw.endsWith('}') ? raw.slice(1, -1) : raw;
}

export class ConfigSnapshot {
  private configs = new Map<string, ClientConfig>();
  private lastRefreshedAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly refreshMs: number,
  ) {}

  /** Initial load + periodic refresh. Boot does not block on Redis being up. */
  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref(); // never keep the process alive just for refreshes
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(): Promise<void> {
    try {
      // SCAN (not KEYS): non-blocking iteration; config cardinality is small
      // (hundreds of clients) so a full sweep per refresh is cheap.
      const next = new Map<string, ClientConfig>();
      let cursor = '0';
      do {
        const [newCursor, keys] = await this.redis.scan(
          cursor, 'MATCH', CONFIG_KEY_PATTERN, 'COUNT', 200,
        );
        cursor = newCursor;
        for (const key of keys) {
          const hash = await this.redis.hgetall(key);
          const config = parseConfigHash(hash);
          if (config) next.set(clientIdFromKey(key), config);
        }
      } while (cursor !== '0');

      // Only replace the snapshot on a fully successful sweep — a partial
      // failure mid-scan must not wipe clients we already knew about.
      this.configs = next;
      this.lastRefreshedAt = Date.now();
    } catch {
      // Redis unreachable: keep serving the last-known-good snapshot.
    }
  }

  get(clientId: string): ClientConfig | undefined {
    return this.configs.get(clientId);
  }

  /** Milliseconds since the last successful refresh; null = never succeeded. */
  ageMs(): number | null {
    return this.lastRefreshedAt === null ? null : Date.now() - this.lastRefreshedAt;
  }

  size(): number {
    return this.configs.size;
  }
}
