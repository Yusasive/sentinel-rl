/**
 * Decision orchestration under failure (TRD §10.1): Redis errors must feed
 * the breaker and fall back locally WITHIN the same request; the per-client
 * outage policy must be honored; recovery must reset degraded state.
 * Redis is faked — only the orchestration logic is under test here.
 */
import { LimiterService } from '../src/limiter/limiterService';
import { CircuitBreaker } from '../src/limiter/circuitBreaker';
import { LocalTokenBucket } from '../src/limiter/tokenBucket';
import { ConfigSnapshot } from '../src/limiter/configSnapshot';
import type { RateLimiterRedis } from '../src/redis/client';
import type { ClientConfig, LuaCheckResult } from '../src/types';

/** Fake Redis: scripted responses for slidingWindowCheck. */
function makeFakeRedis(handler: () => Promise<LuaCheckResult>): RateLimiterRedis {
  return { slidingWindowCheck: handler } as unknown as RateLimiterRedis;
}

/** Snapshot stub with fixed in-memory configs (bypasses real refresh). */
function makeSnapshot(configs: Record<string, ClientConfig>): ConfigSnapshot {
  const snapshot = new ConfigSnapshot(undefined as never, 60_000);
  (snapshot as unknown as { configs: Map<string, ClientConfig> }).configs = new Map(
    Object.entries(configs),
  );
  return snapshot;
}

const openClient: ClientConfig = { limit: 100, windowSeconds: 60, onOutage: 'open' };
const closedClient: ClientConfig = { limit: 50, windowSeconds: 60, onOutage: 'closed' };

function makeService(
  redisHandler: () => Promise<LuaCheckResult>,
  configs: Record<string, ClientConfig> = { 'client-a': openClient, 'bank-strict': closedClient },
) {
  const breaker = new CircuitBreaker({ failureThreshold: 2, openMs: 60_000 });
  const service = new LimiterService(
    makeFakeRedis(redisHandler),
    breaker,
    new LocalTokenBucket({ instanceCount: 3, fallbackFraction: 0.5 }),
    makeSnapshot(configs),
  );
  return { service, breaker };
}

describe('LimiterService', () => {
  it('returns a normal-mode decision when Redis answers', async () => {
    const { service } = makeService(async () => [1, 42, 0]);
    const result = await service.check('client-a');
    expect(result).toEqual({
      kind: 'decision',
      decision: { allowed: true, remaining: 42, retryAfterMs: 0, mode: 'normal' },
    });
  });

  it('maps the Lua unknown-client sentinel to unknown-client', async () => {
    const { service } = makeService(async () => [-1, 0, 0]);
    const result = await service.check('ghost');
    expect(result).toEqual({ kind: 'unknown-client' });
  });

  it('serves the SAME request from fallback when Redis fails (no caller-visible error)', async () => {
    const { service } = makeService(async () => {
      throw new Error('connection refused');
    });
    const result = await service.check('client-a');
    expect(result.kind).toBe('decision');
    if (result.kind === 'decision') {
      expect(result.decision.mode).toBe('fallback');
      expect(result.decision.allowed).toBe(true);
    }
  });

  it('opens the breaker after threshold failures and stops calling Redis', async () => {
    let redisCalls = 0;
    const { service, breaker } = makeService(async () => {
      redisCalls += 1;
      throw new Error('timeout');
    });

    await service.check('client-a'); // failure 1
    await service.check('client-a'); // failure 2 → breaker opens
    expect(breaker.getState()).toBe('open');

    await service.check('client-a'); // must not touch Redis anymore
    expect(redisCalls).toBe(2);
  });

  it('honors the fail-closed outage policy during degraded mode', async () => {
    const { service } = makeService(async () => {
      throw new Error('down');
    });

    // bank-strict is onOutage:'closed' → denied, never locally approved.
    const result = await service.check('bank-strict');
    expect(result.kind).toBe('decision');
    if (result.kind === 'decision') {
      expect(result.decision.allowed).toBe(false);
      expect(result.decision.mode).toBe('fallback');
      expect(result.decision.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it('reports unknown-client in fallback when the snapshot has no config', async () => {
    const { service } = makeService(async () => {
      throw new Error('down');
    });
    const result = await service.check('never-configured');
    expect(result).toEqual({ kind: 'unknown-client' });
  });

  it('enforces the bounded fallback budget across repeated degraded checks', async () => {
    const { service } = makeService(async () => {
      throw new Error('down');
    });

    // capacity = floor(100 × 0.5 ÷ 3) = 16 for this instance.
    const decisions = [];
    for (let i = 0; i < 20; i += 1) decisions.push(await service.check('client-a'));
    const allowed = decisions.filter(
      (r) => r.kind === 'decision' && r.decision.allowed,
    ).length;
    expect(allowed).toBe(16);
  });
});
