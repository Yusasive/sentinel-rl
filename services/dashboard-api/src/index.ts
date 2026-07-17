/**
 * Dashboard API bootstrap. On boot, syncs client configs from Postgres into
 * Redis so a freshly seeded stack is immediately usable by the hot path.
 */
import Fastify from 'fastify';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { registerRoutes } from './routes';
import { syncAllConfigs } from './configSync';

const env = {
  port: Number(process.env.PORT ?? 4000),
  redisHost: process.env.REDIS_HOST ?? 'localhost',
  redisPort: Number(process.env.REDIS_PORT ?? 6379),
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://ratelimiter:ratelimiter@localhost:5432/ratelimiter',
};

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: env.databaseUrl, max: 10 });
  const redis = new Redis({ host: env.redisHost, port: env.redisPort });

  // Retry the boot sync until Postgres/Redis are ready — compose healthchecks
  // make this near-instant, but belt-and-braces beats a crash loop.
  for (;;) {
    try {
      const count = await syncAllConfigs(pool, redis);
      console.log(`[dashboard-api] synced ${count} client configs to Redis`);
      break;
    } catch (err) {
      console.error('[dashboard-api] config sync failed, retrying in 2s:', (err as Error).message);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  const app = Fastify({ logger: false });
  registerRoutes(app, { pool, redis });

  await app.listen({ port: env.port, host: '0.0.0.0' });
  console.log(`[dashboard-api] listening on :${env.port}`);
}

void main().catch((err) => {
  console.error('[dashboard-api] fatal:', err);
  process.exit(1);
});
