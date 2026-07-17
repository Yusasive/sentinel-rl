/**
 * Bootstrap: wire env → redis → breaker/fallback/snapshot → limiter → HTTP.
 * Boot never blocks on Redis being up — if it isn't, the breaker opens and
 * the instance serves fallback decisions until Redis appears.
 */
import { loadEnv } from './env';
import { createRedisClient } from './redis/client';
import { CircuitBreaker } from './limiter/circuitBreaker';
import { LocalTokenBucket } from './limiter/tokenBucket';
import { ConfigSnapshot } from './limiter/configSnapshot';
import { LimiterService } from './limiter/limiterService';
import { StreamLogger } from './logging/streamLogger';
import { buildServer } from './server';
import { fallbackActivations } from './metrics';

async function main(): Promise<void> {
  const env = loadEnv();
  const redis = createRedisClient(env);

  const breaker = new CircuitBreaker({
    failureThreshold: env.BREAKER_FAILURE_THRESHOLD,
    openMs: env.BREAKER_OPEN_MS,
  });
  breaker.onOpen = () => {
    fallbackActivations.inc();
    // Ops signal (TRD §5.5): degraded mode is active, alert on this line.
    console.warn(`[${env.INSTANCE_ID}] circuit OPEN — serving local fallback decisions`);
  };

  const fallback = new LocalTokenBucket({
    instanceCount: env.INSTANCE_COUNT,
    fallbackFraction: env.FALLBACK_FRACTION,
  });
  const snapshot = new ConfigSnapshot(redis, env.CONFIG_REFRESH_MS);
  const logger = new StreamLogger(redis);
  const limiter = new LimiterService(redis, breaker, fallback, snapshot);

  // LimiterService installed its own onClose (fallback bucket reset) in its
  // constructor — wrap it, don't replace it, so both behaviors run.
  const resetOnClose = breaker.onClose;
  breaker.onClose = () => {
    resetOnClose?.();
    console.warn(`[${env.INSTANCE_ID}] circuit CLOSED — Redis recovered, normal mode`);
  };

  snapshot.start();
  logger.start();

  const app = buildServer({
    limiter,
    logger,
    snapshot,
    breaker,
    redis,
    instanceId: env.INSTANCE_ID,
  });

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  console.log(`[${env.INSTANCE_ID}] rate limiter listening on :${env.PORT}`);

  const shutdown = async (): Promise<void> => {
    snapshot.stop();
    logger.stop();
    await app.close();
    redis.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

void main();
