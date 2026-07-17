/**
 * HTTP surface of the rate limiter (TRD §8).
 *
 *   POST /check   — the hot path. Body {clientId} → decision tuple + requestId.
 *   POST /report  — optional post-hoc upstream outcome report (off hot path).
 *   GET  /health  — liveness + operating mode (normal vs fallback).
 *   GET  /metrics — Prometheus exposition.
 *
 * /check returns HTTP 200 for BOTH allowed and denied: the decision API
 * itself succeeded; `allowed: false` is data, not an HTTP error. Unknown
 * clients are 404, malformed bodies 400.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LimiterService } from './limiter/limiterService';
import type { StreamLogger } from './logging/streamLogger';
import { REPORT_STREAM } from './logging/streamLogger';
import type { ConfigSnapshot } from './limiter/configSnapshot';
import type { CircuitBreaker } from './limiter/circuitBreaker';
import type { RateLimiterRedis } from './redis/client';
import { registry, decisionLatency, decisionsTotal } from './metrics';

const checkBody = z.object({
  clientId: z.string().min(1).max(128),
});

const reportBody = z.object({
  requestId: z.string().uuid(),
  upstreamResponseTimeMs: z.number().int().nonnegative(),
  upstreamStatus: z.number().int().min(100).max(599),
});

export interface ServerDeps {
  limiter: LimiterService;
  logger: StreamLogger;
  snapshot: ConfigSnapshot;
  breaker: CircuitBreaker;
  redis: RateLimiterRedis;
  instanceId: string;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  // Per-request logging off: writing a log line per /check would put disk
  // I/O on exactly the path that must stay in the low-ms range.
  const app = Fastify({ logger: false });

  app.post('/check', async (request, reply) => {
    const started = process.hrtime.bigint();

    const parsed = checkBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_request',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const { clientId } = parsed.data;

    const result = await deps.limiter.check(clientId);

    if (result.kind === 'unknown-client') {
      return reply.status(404).send({
        error: 'unknown_client',
        message: `No rate limit configuration for client '${clientId}'`,
      });
    }

    const { decision } = result;
    const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
    const requestId = randomUUID();

    // Observability + billing log — both strictly after the decision, and
    // the XADD inside log() is fire-and-forget (never awaited here).
    decisionLatency.observe({ mode: decision.mode }, latencyMs);
    decisionsTotal.inc({
      outcome: decision.allowed ? 'allowed' : 'denied',
      mode: decision.mode,
    });
    deps.logger.log({
      requestId,
      clientId,
      ts: Date.now(),
      decisionLatencyMs: Math.round(latencyMs * 1000) / 1000,
      outcome: decision.allowed ? 'allowed' : 'denied',
      mode: decision.mode,
    });

    return reply.status(200).send({
      allowed: decision.allowed,
      remaining: decision.remaining,
      retryAfterMs: decision.retryAfterMs > 0 ? decision.retryAfterMs : undefined,
      requestId,
      mode: decision.mode, // callers/ops can see degraded decisions explicitly
    });
  });

  // Callers report the actual third-party outcome here after making their
  // call (TRD §6.1). Enriches the billing log; entirely off the hot path.
  app.post('/report', async (request, reply) => {
    const parsed = reportBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_request',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const { requestId, upstreamResponseTimeMs, upstreamStatus } = parsed.data;

    try {
      await deps.redis.xadd(
        REPORT_STREAM, '*',
        'requestId', requestId,
        'upstreamResponseTimeMs', String(upstreamResponseTimeMs),
        'upstreamStatus', String(upstreamStatus),
        'attempts', '0',
      );
      return reply.status(202).send({ accepted: true });
    } catch {
      // Reports are best-effort enrichment; during an outage we shed them
      // rather than buffer (decision logs get the buffer budget).
      return reply.status(503).send({ error: 'report_unavailable' });
    }
  });

  app.get('/health', async (_request, reply) => {
    const breakerState = deps.breaker.getState();
    const mode = breakerState === 'closed' ? 'normal' : 'fallback';
    return reply.status(200).send({
      status: 'ok',
      instanceId: deps.instanceId,
      mode,
      breaker: breakerState,
      redis: deps.redis.status, // ioredis connection state string
      configSnapshot: {
        clients: deps.snapshot.size(),
        ageMs: deps.snapshot.ageMs(),
      },
      logBuffer: deps.logger.stats(),
    });
  });

  app.get('/metrics', async (_request, reply) => {
    reply.header('Content-Type', registry.contentType);
    return reply.send(await registry.metrics());
  });

  return app;
}
