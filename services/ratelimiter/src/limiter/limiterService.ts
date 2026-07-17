/**
 * Decision orchestration: atomic Redis path when healthy, bounded local
 * fallback when degraded. This is the only module that knows both paths.
 *
 * Flow per check (TRD §5):
 *   breaker closed  → single EVALSHA round trip (config + decision, atomic)
 *   breaker open    → local decision from snapshot + token bucket, zero
 *                     network I/O — a dead Redis costs no latency at all
 *   Redis error     → feeds the breaker, then falls through to the local
 *                     path for THIS request too (no failed checks surfaced
 *                     to callers because of an infra hiccup)
 */
import { CircuitBreaker } from './circuitBreaker';
import { LocalTokenBucket } from './tokenBucket';
import { ConfigSnapshot } from './configSnapshot';
import { configKey, counterKeyPrefix, type RateLimiterRedis } from '../redis/client';
import { LUA_UNKNOWN_CLIENT, type Decision } from '../types';

/** Check outcome: a decision, or "no such client" (HTTP 404 at the route). */
export type CheckResult =
  | { kind: 'decision'; decision: Decision }
  | { kind: 'unknown-client' };

export class LimiterService {
  constructor(
    private readonly redis: RateLimiterRedis,
    private readonly breaker: CircuitBreaker,
    private readonly fallback: LocalTokenBucket,
    private readonly snapshot: ConfigSnapshot,
  ) {
    // On recovery, drop degraded-mode bucket state so the next outage
    // starts from a full (not depleted) conservative budget.
    this.breaker.onClose = () => this.fallback.reset();
  }

  async check(clientId: string): Promise<CheckResult> {
    if (this.breaker.canAttempt()) {
      try {
        const [allowed, remaining, retryAfterMs] = await this.redis.slidingWindowCheck(
          configKey(clientId),
          counterKeyPrefix(clientId),
        );
        this.breaker.onSuccess();

        if (allowed === LUA_UNKNOWN_CLIENT) {
          // Redis is healthy and authoritative: the client has no config.
          return { kind: 'unknown-client' };
        }
        return {
          kind: 'decision',
          decision: {
            allowed: allowed === 1,
            remaining,
            retryAfterMs,
            mode: 'normal',
          },
        };
      } catch {
        // Timeout / connection refused / probe failure — count it and use
        // the local path for this request. Callers never see the hiccup.
        this.breaker.onFailure();
      }
    }
    return this.checkLocal(clientId);
  }

  /** Degraded-mode decision: in-memory snapshot + per-client outage policy. */
  private checkLocal(clientId: string): CheckResult {
    const config = this.snapshot.get(clientId);
    if (!config) {
      // Not in the last-known-good snapshot either → genuinely unknown.
      return { kind: 'unknown-client' };
    }

    if (config.onOutage === 'closed') {
      // Fail-closed policy (e.g., banking API where overage carries hard
      // penalties): during an outage, denying is cheaper than overrunning.
      return {
        kind: 'decision',
        decision: {
          allowed: false,
          remaining: 0,
          // Honest signal: retry when the breaker will next probe Redis.
          retryAfterMs: 1000,
          mode: 'fallback',
        },
      };
    }

    return { kind: 'decision', decision: this.fallback.consume(clientId, config) };
  }
}
