/**
 * Environment configuration, validated once at boot.
 * Fails fast with a readable message instead of surfacing NaNs at runtime.
 */
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  /**
   * Hot-path budget for any single Redis command. Past this the call counts
   * as a failure and the circuit breaker moves toward fallback mode — a slow
   * Redis must degrade us, not stall every caller (TRD §5.1).
   */
  REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(50),
  /** Expected limiter instance count; seeds the conservative fallback bucket. */
  INSTANCE_COUNT: z.coerce.number().int().positive().default(3),
  /**
   * Fraction of a client's limit the *whole fleet* may serve while degraded.
   * Each instance gets (limit * fraction / instanceCount) per window, so the
   * worst-case fleet-wide overage during an outage stays bounded (TRD §5.3).
   */
  FALLBACK_FRACTION: z.coerce.number().positive().max(1).default(0.5),
  /** Refresh interval for the in-memory last-known-good config snapshot. */
  CONFIG_REFRESH_MS: z.coerce.number().int().positive().default(10_000),
  /** Consecutive Redis failures before the circuit opens. */
  BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(3),
  /** How long the circuit stays open before allowing a half-open probe. */
  BREAKER_OPEN_MS: z.coerce.number().int().positive().default(2000),
  /** Identifies this instance in /health, logs, and metrics. */
  INSTANCE_ID: z.string().default('rl-local'),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}
