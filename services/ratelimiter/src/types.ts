/**
 * Shared types for the rate limiter service.
 * Everything downstream (routes, logging, fallback) derives from these.
 */

/** Per-client configuration, mirrored from Redis hash ratelimit:config:{id}. */
export interface ClientConfig {
  /** Max requests allowed per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /**
   * Outage policy when Redis is unreachable (TRD §5):
   *  - 'open':   bounded local fallback keeps traffic flowing (default)
   *  - 'closed': deny all requests for this client while degraded
   */
  onOutage: 'open' | 'closed';
}

/** Operating mode a decision was made under. */
export type DecisionMode = 'normal' | 'fallback';

/** Result of a rate-limit check. */
export interface Decision {
  allowed: boolean;
  /** Estimated remaining budget in the current window (0 when denied). */
  remaining: number;
  /** How long the caller should wait before retrying (only when denied). */
  retryAfterMs: number;
  /** 'normal' = atomic Redis decision; 'fallback' = degraded local decision. */
  mode: DecisionMode;
}

/** Raw tuple returned by the Lua script: [allowed, remaining, retryAfterMs]. */
export type LuaCheckResult = [number, number, number];

/** Sentinel value the Lua script returns when the client has no config. */
export const LUA_UNKNOWN_CLIENT = -1;
