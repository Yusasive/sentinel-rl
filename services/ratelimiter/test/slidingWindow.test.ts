/**
 * Sliding-window-counter edge cases (TRD §10.1): window boundaries, the
 * burst-at-boundary problem fixed-window suffers, and the approximation
 * boundary the race-condition test depends on.
 */
import {
  estimateUsage,
  isAllowed,
  remainingAfterConsume,
  retryAfterMs,
  windowIndex,
  elapsedFraction,
} from '../src/limiter/slidingWindowMath';

describe('sliding window estimate', () => {
  it('is exact inside a fresh window (empty previous window)', () => {
    // The determinism precondition of the race test (TRD §10.2): with
    // previous=0 the estimate degenerates to the exact current count.
    expect(estimateUsage({ current: 42, previous: 0, elapsed: 0.3 })).toBe(42);
  });

  it('weights the previous window by its remaining overlap', () => {
    // 25% into the window → 75% of the previous window still counts.
    expect(estimateUsage({ current: 10, previous: 100, elapsed: 0.25 })).toBe(85);
  });

  it('previous window fully decays as the current window completes', () => {
    expect(estimateUsage({ current: 0, previous: 100, elapsed: 1 })).toBe(0);
  });

  it('prevents the fixed-window burst-at-boundary problem', () => {
    // Fixed-window would allow 2×limit around a boundary: 100 at the end of
    // window N plus another 100 at the start of window N+1. Here, just after
    // the boundary the previous 100 still weighs 99, so only ONE request fits
    // (estimate 99 < 100) — and after it lands (current=1, estimate 100) the
    // next is denied. ~1 extra vs fixed-window's ~100 extra.
    expect(isAllowed({ current: 0, previous: 100, elapsed: 0.01 }, 100)).toBe(true);
    expect(isAllowed({ current: 1, previous: 100, elapsed: 0.01 }, 100)).toBe(false);
  });

  it('allows exactly at the limit boundary (estimate < limit rule)', () => {
    expect(isAllowed({ current: 99, previous: 0, elapsed: 0.5 }, 100)).toBe(true);
    expect(isAllowed({ current: 100, previous: 0, elapsed: 0.5 }, 100)).toBe(false);
  });
});

describe('remaining budget', () => {
  it('reports remaining after consuming the current slot', () => {
    expect(remainingAfterConsume({ current: 0, previous: 0, elapsed: 0 }, 100)).toBe(99);
    expect(remainingAfterConsume({ current: 98, previous: 0, elapsed: 0 }, 100)).toBe(1);
  });

  it('never goes negative when the weighted estimate crowds the limit', () => {
    expect(remainingAfterConsume({ current: 50, previous: 99, elapsed: 0.1 }, 100)).toBe(0);
  });
});

describe('retry hint', () => {
  it('points at the current window rollover', () => {
    expect(retryAfterMs({ current: 0, previous: 0, elapsed: 0.75 }, 60)).toBe(15_000);
  });

  it('is always at least 1ms, even at the very end of a window', () => {
    expect(retryAfterMs({ current: 0, previous: 0, elapsed: 1 }, 60)).toBe(1);
  });
});

describe('window indexing', () => {
  it('maps timestamps to fixed windows', () => {
    expect(windowIndex(120, 60)).toBe(2);
    expect(windowIndex(179.999, 60)).toBe(2);
    expect(windowIndex(180, 60)).toBe(3); // boundary belongs to the new window
  });

  it('computes the elapsed fraction within the window', () => {
    expect(elapsedFraction(120, 60)).toBe(0);
    expect(elapsedFraction(150, 60)).toBeCloseTo(0.5);
    expect(elapsedFraction(179.999, 60)).toBeCloseTo(0.99998, 4);
  });
});
