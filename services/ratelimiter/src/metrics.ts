/**
 * Prometheus metrics (TRD §12). Scraped from GET /metrics.
 * The latency histogram is the SLA evidence: p99 of decision_latency must sit
 * in the low single-digit milliseconds under load (verified by k6).
 */
import { Registry, Histogram, Counter, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

/** End-to-end in-process decision latency (parse → decision), in ms. */
export const decisionLatency = new Histogram({
  name: 'ratelimiter_decision_latency_ms',
  help: 'Rate-limit decision latency in milliseconds',
  // Buckets bracket the SLA: sub-ms through "something is wrong".
  buckets: [0.5, 1, 2, 3, 5, 8, 13, 21, 50, 100],
  labelNames: ['mode'] as const,
  registers: [registry],
});

/** Allow/deny counts, split by decision mode for degraded-mode visibility. */
export const decisionsTotal = new Counter({
  name: 'ratelimiter_decisions_total',
  help: 'Rate-limit decisions by outcome and mode',
  labelNames: ['outcome', 'mode'] as const,
  registers: [registry],
});

/** Fires on each closed→open breaker transition — the alerting signal that
 *  degraded mode is active (TRD §5.5). */
export const fallbackActivations = new Counter({
  name: 'ratelimiter_fallback_activations_total',
  help: 'Number of times the circuit breaker opened (fallback mode engaged)',
  registers: [registry],
});
