/**
 * Async decision logging — off the hot path by construction (TRD §6).
 *
 * XADD is fire-and-forget: the HTTP response NEVER waits on it, and an XADD
 * failure can never fail a rate-limit decision. Billing durability comes from
 * the downstream pipeline (AOF-persisted stream → consumer group → idempotent
 * Postgres writes), not from blocking callers here.
 *
 * During a Redis outage XADDs fail — so fallback-mode decisions are buffered
 * in a bounded in-memory queue and drained on recovery. Bounded, because an
 * unbounded queue during a long outage is just an OOM with extra steps; if
 * the buffer fills, the oldest entries are dropped and the drop count is
 * surfaced (documented residual gap, TRD §13).
 */
import type Redis from 'ioredis';

export const REQUEST_LOG_STREAM = 'request-log-stream';
export const REPORT_STREAM = 'report-stream';

/** Approximate cap on stream length; ~ uses XADD MAXLEN '~' for O(1) trims. */
const STREAM_MAXLEN = 1_000_000;
const BUFFER_MAX = 10_000;
const DRAIN_INTERVAL_MS = 1000;

export interface DecisionLogEntry {
  requestId: string;
  clientId: string;
  /** Decision timestamp (ms epoch). */
  ts: number;
  decisionLatencyMs: number;
  outcome: 'allowed' | 'denied';
  mode: 'normal' | 'fallback';
}

export class StreamLogger {
  private buffer: DecisionLogEntry[] = [];
  private dropped = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly redis: Redis) {}

  start(): void {
    this.timer = setInterval(() => void this.drain(), DRAIN_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Fire-and-forget: returns immediately, failures go to the buffer. */
  log(entry: DecisionLogEntry): void {
    this.xadd(entry).catch(() => this.bufferEntry(entry));
  }

  private async xadd(entry: DecisionLogEntry): Promise<void> {
    await this.redis.xadd(
      REQUEST_LOG_STREAM,
      'MAXLEN', '~', STREAM_MAXLEN,
      '*',
      'requestId', entry.requestId,
      'clientId', entry.clientId,
      'ts', String(entry.ts),
      'decisionLatencyMs', String(entry.decisionLatencyMs),
      'outcome', entry.outcome,
      'mode', entry.mode,
    );
  }

  private bufferEntry(entry: DecisionLogEntry): void {
    if (this.buffer.length >= BUFFER_MAX) {
      this.buffer.shift(); // drop oldest — recent entries are worth more
      this.dropped += 1;
    }
    this.buffer.push(entry);
  }

  /** Retry buffered entries; stops at first failure (Redis still down). */
  private async drain(): Promise<void> {
    while (this.buffer.length > 0) {
      const entry = this.buffer[0];
      if (!entry) return;
      try {
        await this.xadd(entry);
        this.buffer.shift();
      } catch {
        return; // still down; try again next tick
      }
    }
  }

  /** Exposed on /health so a filling buffer is visible before it drops. */
  stats(): { buffered: number; dropped: number } {
    return { buffered: this.buffer.length, dropped: this.dropped };
  }
}
