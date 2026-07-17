/**
 * Redis connection tuned for a hot path that must fail FAST, not hang:
 *
 *  - commandTimeout: any command slower than the budget (50ms default) is an
 *    error → feeds the circuit breaker → fallback mode. A slow Redis must
 *    degrade us gracefully, never stall every caller behind it.
 *  - enableOfflineQueue: false — when the connection is down, commands reject
 *    immediately instead of buffering. Buffered commands would make every
 *    caller wait out the outage, which is exactly the failure mode the
 *    fail-safe strategy exists to prevent.
 *  - maxRetriesPerRequest: 0 — no transparent retries on the hot path; the
 *    breaker owns the retry/probe policy, not the driver.
 */
import Redis from 'ioredis';
import { SLIDING_WINDOW_LUA } from './slidingWindow.lua';
import type { Env } from '../env';
import type { LuaCheckResult } from '../types';

/** ioredis client extended with our custom Lua command. */
export interface RateLimiterRedis extends Redis {
  slidingWindowCheck(configKey: string, keyPrefix: string): Promise<LuaCheckResult>;
}

export function createRedisClient(env: Env): RateLimiterRedis {
  const client = new Redis({
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    commandTimeout: env.REDIS_COMMAND_TIMEOUT_MS,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    // Keep reconnecting forever in the background; the breaker decides when
    // to trust the connection again.
    retryStrategy: (times) => Math.min(times * 200, 2000),
  }) as RateLimiterRedis;

  // Registers the script once; ioredis sends EVALSHA and transparently falls
  // back to EVAL if the script cache was flushed (e.g., Redis restart).
  client.defineCommand('slidingWindowCheck', {
    numberOfKeys: 1,
    lua: SLIDING_WINDOW_LUA,
  });

  // Without an error listener ioredis throws on unhandled connection errors.
  // Connection state is surfaced via the breaker + /health, not the console.
  client.on('error', () => undefined);

  return client;
}

/** Key helpers — single definition so app and tests can never drift.
 *  The {clientId} braces are a deliberate Redis hash tag: every key for one
 *  client hashes to the same slot, which multi-key Lua would require under
 *  Redis Cluster (TRD §4.1). */
export const configKey = (clientId: string): string => `ratelimit:config:{${clientId}}`;
export const counterKeyPrefix = (clientId: string): string => `ratelimit:{${clientId}}:`;
