/**
 * Circuit breaker state machine — the fail-safe strategy's control logic
 * (TRD §10.1: "fallback activation/deactivation, breaker transitions").
 * Uses an injected fake clock: no timers, fully deterministic.
 */
import { CircuitBreaker } from '../src/limiter/circuitBreaker';

function makeBreaker(overrides: { failureThreshold?: number; openMs?: number } = {}) {
  let nowMs = 0;
  const breaker = new CircuitBreaker({
    failureThreshold: overrides.failureThreshold ?? 3,
    openMs: overrides.openMs ?? 2000,
    now: () => nowMs,
  });
  return { breaker, advance: (ms: number) => (nowMs += ms) };
}

describe('CircuitBreaker', () => {
  it('starts closed and allows attempts', () => {
    const { breaker } = makeBreaker();
    expect(breaker.getState()).toBe('closed');
    expect(breaker.canAttempt()).toBe(true);
  });

  it('stays closed below the failure threshold', () => {
    const { breaker } = makeBreaker({ failureThreshold: 3 });
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.getState()).toBe('closed');
    expect(breaker.canAttempt()).toBe(true);
  });

  it('opens after N consecutive failures and fires onOpen exactly once', () => {
    const { breaker } = makeBreaker({ failureThreshold: 3 });
    let opened = 0;
    breaker.onOpen = () => (opened += 1);

    breaker.onFailure();
    breaker.onFailure();
    breaker.onFailure();

    expect(breaker.getState()).toBe('open');
    expect(opened).toBe(1);
    expect(breaker.canAttempt()).toBe(false); // no Redis calls while open
  });

  it('a success resets the consecutive-failure count', () => {
    const { breaker } = makeBreaker({ failureThreshold: 3 });
    breaker.onFailure();
    breaker.onFailure();
    breaker.onSuccess(); // interrupts the streak
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.getState()).toBe('closed');
  });

  it('admits exactly one probe after the open period', () => {
    const { breaker, advance } = makeBreaker({ failureThreshold: 1, openMs: 2000 });
    breaker.onFailure();
    expect(breaker.getState()).toBe('open');

    advance(1999);
    expect(breaker.canAttempt()).toBe(false); // still cooling down

    advance(1);
    expect(breaker.canAttempt()).toBe(true); // the single half-open probe
    expect(breaker.getState()).toBe('half-open');
    expect(breaker.canAttempt()).toBe(false); // concurrent requests stay local
  });

  it('probe success closes the circuit and fires onClose', () => {
    const { breaker, advance } = makeBreaker({ failureThreshold: 1, openMs: 100 });
    let closed = 0;
    breaker.onClose = () => (closed += 1);

    breaker.onFailure();
    advance(100);
    expect(breaker.canAttempt()).toBe(true);
    breaker.onSuccess();

    expect(breaker.getState()).toBe('closed');
    expect(closed).toBe(1);
    expect(breaker.canAttempt()).toBe(true);
  });

  it('probe failure reopens the circuit and restarts the cool-down', () => {
    const { breaker, advance } = makeBreaker({ failureThreshold: 1, openMs: 100 });
    breaker.onFailure();
    advance(100);
    expect(breaker.canAttempt()).toBe(true); // probe admitted
    breaker.onFailure(); // probe failed

    expect(breaker.getState()).toBe('open');
    advance(99);
    expect(breaker.canAttempt()).toBe(false); // full cool-down restarted
    advance(1);
    expect(breaker.canAttempt()).toBe(true);
  });
});
