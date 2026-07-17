/**
 * Circuit breaker guarding the Redis hot path (TRD §5).
 *
 * States:
 *   closed    → Redis trusted; every check goes to the atomic Lua script.
 *   open      → Redis distrusted after N consecutive failures; all checks go
 *               to the local fallback. No Redis calls are attempted, so a
 *               dead Redis costs zero latency instead of a timeout per call.
 *   half-open → after openMs, exactly ONE request is allowed through as a
 *               probe. Success closes the circuit; failure re-opens it.
 *
 * Deliberately dependency-free and clock-injectable so state transitions are
 * unit-testable without timers or a real Redis.
 */

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures required to open the circuit. */
  failureThreshold: number;
  /** How long the circuit stays open before allowing a half-open probe. */
  openMs: number;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

export class CircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeInFlight = false;
  private state: BreakerState = 'closed';
  private readonly now: () => number;

  /** Invoked on closed→open transitions (metrics/alerting hook). */
  onOpen?: () => void;
  /** Invoked when the circuit closes again after recovery. */
  onClose?: () => void;

  constructor(private readonly opts: CircuitBreakerOptions) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * May this request attempt Redis?
   * In half-open, only a single probe is admitted at a time — flooding a
   * just-recovered Redis with the full backlog could knock it over again.
   */
  canAttempt(): boolean {
    if (this.state === 'closed') return true;

    if (this.state === 'open') {
      if (this.now() - this.openedAt >= this.opts.openMs) {
        this.state = 'half-open';
        this.probeInFlight = true; // this caller becomes the probe
        return true;
      }
      return false;
    }

    // half-open: admit nothing while the probe is out.
    if (!this.probeInFlight) {
      this.probeInFlight = true;
      return true;
    }
    return false;
  }

  onSuccess(): void {
    const wasDegraded = this.state !== 'closed';
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.probeInFlight = false;
    if (wasDegraded) this.onClose?.();
  }

  onFailure(): void {
    this.probeInFlight = false;
    if (this.state === 'half-open') {
      // Probe failed — straight back to open, restart the cool-down.
      this.state = 'open';
      this.openedAt = this.now();
      return;
    }
    this.consecutiveFailures += 1;
    if (this.state === 'closed' && this.consecutiveFailures >= this.opts.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.now();
      this.onOpen?.();
    }
  }

  getState(): BreakerState {
    return this.state;
  }
}
