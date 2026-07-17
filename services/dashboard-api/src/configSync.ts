/**
 * Config synchronization: Postgres (durable source of truth) → Redis hashes
 * (what the hot path actually reads).
 *
 * Runs at boot (so a fresh stack is usable immediately after seed) and after
 * every config write — which is how FR1/FR7's "limits changeable without
 * redeploy" works: PUT /config/:clientId updates Postgres, re-syncs the Redis
 * hash, and every limiter instance picks it up on its next EVALSHA (instantly)
 * and its snapshot refresh (within seconds).
 */
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import { configKey } from './redisKeys';

export interface ClientConfigRow {
  client_id: string;
  name: string;
  limit_per_window: number;
  window_seconds: number;
  on_outage: 'open' | 'closed';
}

export async function syncClientToRedis(redis: Redis, row: ClientConfigRow): Promise<void> {
  await redis.hset(configKey(row.client_id), {
    limit: String(row.limit_per_window),
    windowSeconds: String(row.window_seconds),
    onOutage: row.on_outage,
  });
}

export async function syncAllConfigs(pool: Pool, redis: Redis): Promise<number> {
  const result = await pool.query<ClientConfigRow>(
    `SELECT client_id, name, limit_per_window, window_seconds, on_outage
       FROM client_configs`,
  );
  for (const row of result.rows) {
    await syncClientToRedis(redis, row);
  }
  return result.rowCount ?? 0;
}
