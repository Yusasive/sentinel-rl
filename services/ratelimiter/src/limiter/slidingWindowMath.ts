/**
 * Pure sliding-window-counter math — the exact formula the Lua script runs
 * inside Redis (src/redis/slidingWindow.lua.ts), mirrored in TypeScript so
 * the algorithm's edge cases are unit-testable without infrastructure.
 *
 * The authoritative decision path is the Lua script (atomicity lives there);
 * keep the two implementations in lock-step — the unit tests below are the
 * spec both must satisfy.
 */

export interface WindowState {
  /** Requests counted in the current fixed window. */
  current: number;
  /** Requests counted in the previous fixed window. */
  previous: number;
  /** Fraction of the current window already elapsed, 0.0 – 1.0. */
  elapsed: number;
}

/**
 * Weighted estimate of requests in the sliding window: the previous window
 * contributes the fraction of it that still overlaps.
 */
export function estimateUsage(state: WindowState): number {
  return state.previous * (1 - state.elapsed) + state.current;
}

export function isAllowed(state: WindowState, limit: number): boolean {
  return estimateUsage(state) < limit;
}

/** Remaining budget after taking one slot (what the Lua returns on allow). */
export function remainingAfterConsume(state: WindowState, limit: number): number {
  return Math.max(0, Math.floor(limit - estimateUsage(state) - 1));
}

/** Retry hint when denied: time until the current fixed window rolls over. */
export function retryAfterMs(state: WindowState, windowSeconds: number): number {
  return Math.max(1, Math.ceil((1 - state.elapsed) * windowSeconds * 1000));
}

/** Which fixed window an epoch timestamp falls in. */
export function windowIndex(nowSeconds: number, windowSeconds: number): number {
  return Math.floor(nowSeconds / windowSeconds);
}

/** Elapsed fraction of the current fixed window. */
export function elapsedFraction(nowSeconds: number, windowSeconds: number): number {
  const index = windowIndex(nowSeconds, windowSeconds);
  return (nowSeconds - index * windowSeconds) / windowSeconds;
}
