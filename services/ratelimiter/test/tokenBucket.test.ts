/**
 * Local fallback token bucket — verifies the bounded fail-open guarantee:
 * during an outage each instance approves at most limit×fraction÷instances
 * per window, so the fleet-wide overage risk stays bounded (TRD §5.3).
 */
import { LocalTokenBucket } from '../src/limiter/tokenBucket';
import type { ClientConfig } from '../src/types';

const config: ClientConfig = { limit: 100, windowSeconds: 60, onOutage: 'open' };

function makeBucket(instanceCount = 3, fallbackFraction = 0.5) {
  let nowMs = 0;
  const bucket = new LocalTokenBucket({
    instanceCount,
    fallbackFraction,
    now: () => nowMs,
  });
  return { bucket, advance: (ms: number) => (nowMs += ms) };
}

describe('LocalTokenBucket', () => {
  it('derives per-instance capacity = limit × fraction ÷ instances', () => {
    const { bucket } = makeBucket(3, 0.5);
    expect(bucket.capacityFor(config)).toBe(16); // floor(100*0.5/3)
  });

  it('never rounds capacity below 1 (tiny limits must still flow)', () => {
    const { bucket } = makeBucket(10, 0.5);
    expect(bucket.capacityFor({ ...config, limit: 5 })).toBe(1);
  });

  it('allows exactly the capacity, then denies — the bounded guarantee', () => {
    const { bucket } = makeBucket(3, 0.5); // capacity 16
    const decisions = Array.from({ length: 20 }, () => bucket.consume('client-a', config));

    const allowed = decisions.filter((d) => d.allowed).length;
    expect(allowed).toBe(16);
    expect(decisions[16]?.allowed).toBe(false);
    expect(decisions.every((d) => d.mode === 'fallback')).toBe(true);
  });

  it('denied decisions carry a positive retryAfterMs', () => {
    const { bucket } = makeBucket(3, 0.5);
    for (let i = 0; i < 16; i += 1) bucket.consume('client-a', config);
    const denied = bucket.consume('client-a', config);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('refills continuously with elapsed time', () => {
    const { bucket, advance } = makeBucket(3, 0.5); // 16 tokens / 60s
    for (let i = 0; i < 16; i += 1) bucket.consume('client-a', config);
    expect(bucket.consume('client-a', config).allowed).toBe(false);

    // 16 tokens per 60s → one token every 3.75s.
    advance(4000);
    expect(bucket.consume('client-a', config).allowed).toBe(true);
    expect(bucket.consume('client-a', config).allowed).toBe(false); // only 1 accrued
  });

  it('caps refill at capacity (no banking beyond one window)', () => {
    const { bucket, advance } = makeBucket(3, 0.5); // capacity 16
    bucket.consume('client-a', config);
    advance(10 * 60_000); // ten idle windows
    let allowed = 0;
    for (let i = 0; i < 30; i += 1) {
      if (bucket.consume('client-a', config).allowed) allowed += 1;
    }
    expect(allowed).toBe(16); // still just one window's worth
  });

  it('isolates buckets per client', () => {
    const { bucket } = makeBucket(3, 0.5);
    for (let i = 0; i < 16; i += 1) bucket.consume('client-a', config);
    expect(bucket.consume('client-a', config).allowed).toBe(false);
    expect(bucket.consume('client-b', config).allowed).toBe(true); // unaffected
  });

  it('reset() restores a full budget after Redis recovery', () => {
    const { bucket } = makeBucket(3, 0.5);
    for (let i = 0; i < 16; i += 1) bucket.consume('client-a', config);
    expect(bucket.consume('client-a', config).allowed).toBe(false);
    bucket.reset();
    expect(bucket.consume('client-a', config).allowed).toBe(true);
  });
});
