/**
 * Dashboard API endpoints (TRD §7).
 *
 * Real-time usage reads live Redis counters (effectively zero staleness);
 * historical/analytics queries hit TimescaleDB via time_bucket() — fed by the
 * async pipeline, so they trail real time by a few seconds (accepted in the
 * PRD's resolved questions).
 */
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import { z } from 'zod';
import { requireAuth, getIdentity } from './auth';
import { configKey, counterKeyPrefix } from './redisKeys';
import { syncClientToRedis, type ClientConfigRow } from './configSync';

const trendQuery = z.object({
  days: z.coerce.number().int().refine((d) => [10, 15, 30].includes(d), {
    message: 'days must be 10, 15 or 30',
  }).default(10),
  bucket: z.enum(['hour', 'day']).default('day'),
});

const filterQuery = z.object({
  metric: z.enum(['avgResponseTime', 'avgDecisionLatency', 'count']).default('count'),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  bucket: z.enum(['hour', 'day']).default('hour'),
  outcome: z.enum(['allowed', 'denied']).optional(),
});

const putConfigBody = z.object({
  name: z.string().min(1).max(200).optional(),
  limitPerWindow: z.number().int().positive(),
  windowSeconds: z.number().int().positive().default(60),
  onOutage: z.enum(['open', 'closed']).default('open'),
});

export interface RouteDeps {
  pool: Pool;
  redis: Redis;
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { pool, redis } = deps;
  const auth = requireAuth(pool);

  // ── Real-time usage vs quota — reads the live Redis counters ────────────
  app.get<{ Params: { clientId: string } }>(
    '/usage/:clientId/current',
    { preHandler: auth },
    async (request, reply) => {
      const { clientId } = request.params;

      const config = await redis.hgetall(configKey(clientId));
      if (!config.limit) {
        return reply.status(404).send({ error: 'unknown_client' });
      }
      const limit = Number(config.limit);
      const windowSeconds = Number(config.windowSeconds);

      // Same sliding-window estimate the Lua script computes, re-derived
      // read-only for display. App-clock skew can shift this by a hair; the
      // *decision* path always uses Redis TIME (TRD §4.2) — display only here.
      const nowSec = Date.now() / 1000;
      const currentWindow = Math.floor(nowSec / windowSeconds);
      const elapsed = (nowSec - currentWindow * windowSeconds) / windowSeconds;
      const prefix = counterKeyPrefix(clientId);
      const [currRaw, prevRaw] = await redis.mget(
        `${prefix}${currentWindow}`,
        `${prefix}${currentWindow - 1}`,
      );
      const current = Number(currRaw ?? 0);
      const previous = Number(prevRaw ?? 0);
      const used = Math.min(limit, Math.round(previous * (1 - elapsed) + current));

      return reply.send({
        clientId,
        limit,
        windowSeconds,
        used,
        remaining: Math.max(0, limit - used),
        utilization: Math.min(1, used / limit),
        onOutage: config.onOutage ?? 'open',
      });
    },
  );

  // ── Trend graphs: 10/15/30-day windows, bucketed by TimescaleDB ────────
  app.get<{ Params: { clientId: string } }>(
    '/usage/:clientId/trend',
    { preHandler: auth },
    async (request, reply) => {
      const parsed = trendQuery.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'invalid_query', details: parsed.error.flatten() });
      }
      const { days, bucket } = parsed.data;

      // bucket is enum-constrained ('hour'|'day') — safe to interpolate.
      const result = await pool.query(
        `SELECT time_bucket('1 ${bucket}', requested_at) AS bucket,
                count(*) FILTER (WHERE outcome = 'allowed')::int  AS allowed,
                count(*) FILTER (WHERE outcome = 'denied')::int   AS denied,
                round(avg(decision_latency_ms)::numeric, 3)::float8        AS avg_decision_latency_ms,
                round(avg(upstream_response_time_ms)::numeric, 1)::float8  AS avg_upstream_response_time_ms,
                count(upstream_response_time_ms)::int             AS reported_count
           FROM request_logs
          WHERE client_id = $1
            AND requested_at >= now() - make_interval(days => $2)
          GROUP BY 1
          ORDER BY 1`,
        [request.params.clientId, days],
      );

      return reply.send({
        clientId: request.params.clientId,
        days,
        bucket,
        points: result.rows.map((row) => ({
          bucket: row.bucket,
          allowed: row.allowed,
          denied: row.denied,
          avgDecisionLatencyMs: row.avg_decision_latency_ms,
          // NULL until callers report via POST /report — the dashboard labels
          // coverage instead of conflating this with decision latency.
          avgUpstreamResponseTimeMs: row.avg_upstream_response_time_ms,
          reportedCount: row.reported_count,
        })),
      });
    },
  );

  // ── Free-form filtered metric queries ───────────────────────────────────
  app.get<{ Params: { clientId: string } }>(
    '/usage/:clientId/filter',
    { preHandler: auth },
    async (request, reply) => {
      const parsed = filterQuery.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'invalid_query', details: parsed.error.flatten() });
      }
      const { metric, from, to, bucket, outcome } = parsed.data;

      const metricSql = {
        avgResponseTime: 'round(avg(upstream_response_time_ms)::numeric, 1)::float8',
        avgDecisionLatency: 'round(avg(decision_latency_ms)::numeric, 3)::float8',
        count: 'count(*)::int',
      }[metric];

      const params: unknown[] = [request.params.clientId];
      const where: string[] = ['client_id = $1'];
      if (from) { params.push(from); where.push(`requested_at >= $${params.length}`); }
      if (to)   { params.push(to);   where.push(`requested_at <  $${params.length}`); }
      if (outcome) { params.push(outcome); where.push(`outcome = $${params.length}`); }

      const result = await pool.query(
        `SELECT time_bucket('1 ${bucket}', requested_at) AS bucket,
                ${metricSql} AS value
           FROM request_logs
          WHERE ${where.join(' AND ')}
          GROUP BY 1
          ORDER BY 1`,
        params,
      );

      return reply.send({
        clientId: request.params.clientId,
        metric,
        bucket,
        points: result.rows.map((row) => ({ bucket: row.bucket, value: row.value })),
      });
    },
  );

  // ── Config read ─────────────────────────────────────────────────────────
  app.get<{ Params: { clientId: string } }>(
    '/config/:clientId',
    { preHandler: auth },
    async (request, reply) => {
      const result = await pool.query<ClientConfigRow>(
        `SELECT client_id, name, limit_per_window, window_seconds, on_outage
           FROM client_configs WHERE client_id = $1`,
        [request.params.clientId],
      );
      const row = result.rows[0];
      if (!row) return reply.status(404).send({ error: 'unknown_client' });
      return reply.send({
        clientId: row.client_id,
        name: row.name,
        limitPerWindow: row.limit_per_window,
        windowSeconds: row.window_seconds,
        onOutage: row.on_outage,
      });
    },
  );

  // ── Config write (admin): FR1/FR7 — no redeploy, no downtime ────────────
  app.put<{ Params: { clientId: string } }>(
    '/config/:clientId',
    { preHandler: auth },
    async (request, reply) => {
      if (!getIdentity(request).isAdmin) {
        return reply.status(403).send({ error: 'admin_required' });
      }
      const parsed = putConfigBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
      }
      const { clientId } = request.params;
      const { name, limitPerWindow, windowSeconds, onOutage } = parsed.data;

      // Upsert in Postgres (durable), then sync the Redis hash (hot path).
      // New clients get a generated API key; existing keys are preserved.
      const result = await pool.query<ClientConfigRow>(
        `INSERT INTO client_configs
           (client_id, name, limit_per_window, window_seconds, on_outage, api_key)
         VALUES ($1, COALESCE($2, $1), $3, $4, $5, 'key-' || $1)
         ON CONFLICT (client_id) DO UPDATE SET
           name             = COALESCE($2, client_configs.name),
           limit_per_window = $3,
           window_seconds   = $4,
           on_outage        = $5,
           updated_at       = now()
         RETURNING client_id, name, limit_per_window, window_seconds, on_outage`,
        [clientId, name ?? null, limitPerWindow, windowSeconds, onOutage],
      );

      const row = result.rows[0];
      if (!row) return reply.status(500).send({ error: 'write_failed' });
      await syncClientToRedis(redis, row);

      return reply.send({
        clientId: row.client_id,
        name: row.name,
        limitPerWindow: row.limit_per_window,
        windowSeconds: row.window_seconds,
        onOutage: row.on_outage,
      });
    },
  );

  // ── Client list (admin convenience for the dashboard selector) ──────────
  app.get('/clients', { preHandler: auth }, async (request, reply) => {
    const identity = getIdentity(request);
    const result = identity.isAdmin
      ? await pool.query(
          `SELECT client_id, name, limit_per_window, window_seconds, on_outage
             FROM client_configs WHERE NOT is_admin ORDER BY client_id`,
        )
      : await pool.query(
          `SELECT client_id, name, limit_per_window, window_seconds, on_outage
             FROM client_configs WHERE client_id = $1`,
          [identity.clientId],
        );
    return reply.send(
      result.rows.map((row) => ({
        clientId: row.client_id,
        name: row.name,
        limitPerWindow: row.limit_per_window,
        windowSeconds: row.window_seconds,
        onOutage: row.on_outage,
      })),
    );
  });

  app.get('/health', async (_request, reply) => reply.send({ status: 'ok' }));
}
