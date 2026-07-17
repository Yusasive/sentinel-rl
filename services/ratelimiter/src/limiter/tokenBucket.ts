/**
 * Local in-memory token bucket — the bounded fail-open fallback (TRD §5.3).
 *
 * Active only while the circuit breaker distrusts Redis. Each instance serves
 * a conservative slice of the client's real quota:
 *
 *     capacity per instance = limit × FALLBACK_FRACTION ÷ INSTANCE_COUNT
 *
 * With 3 instances, fraction 0.5 and a 100/min client, each instance may
 * approve ~16/min → the fleet approves ~50/min worst case. The business keeps
 * moving during the outage while the risk of exceeding the provider's real
 * quota stays bounded and tunable — the explicit trade-off the fail-safe
 * strategy documents instead of hiding.
 *
 * Continuous refill (tokens accrue fractionally with elapsed time) rather
 * than window resets: smoother behavior and no thundering-herd at boundaries.
 */
import type { ClientConfig, Decision } from '../types';

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

export interface TokenBucketOptions {
  instanceCount: number;
  fallbackFraction: number;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

export class LocalTokenBucket {
  private readonly buckets = new Map<string, BucketState>();
  private readonly now: () => number;

  constructor(private readonly opts: TokenBucketOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Per-instance capacity for one full window (≥1 so tiny limits still flow). */
  capacityFor(config: ClientConfig): number {
    return Math.max(
      1,
      Math.floor((config.limit * this.opts.fallbackFraction) / this.opts.instanceCount),
    );
  }

  consume(clientId: string, config: ClientConfig): Decision {
    const capacity = this.capacityFor(config);
    const refillPerMs = capacity / (config.windowSeconds * 1000);
    const nowMs = this.now();

    let bucket = this.buckets.get(clientId);
    if (!bucket) {
      // First fallback hit starts with a full slice of the window budget.
      bucket = { tokens: capacity, lastRefillMs: nowMs };
      this.buckets.set(clientId, bucket);
    }

    // Continuous refill, capped at capacity.
    const elapsed = nowMs - bucket.lastRefillMs;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
    bucket.lastRefillMs = nowMs;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        retryAfterMs: 0,
        mode: 'fallback',
      };
    }

    // Time until one whole token has accrued.
    const retryAfterMs = Math.ceil((1 - bucket.tokens) / refillPerMs);
    return { allowed: false, remaining: 0, retryAfterMs, mode: 'fallback' };
  }

  /** Redis recovered — drop degraded state so the next outage starts fresh. */
  reset(): void {
    this.buckets.clear();
  }
}
