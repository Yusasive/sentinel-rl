/**
 * Postgres sink for the log pipeline.
 *
 * Stream delivery is AT-LEAST-ONCE (a worker crash between COMMIT and XACK
 * redelivers the batch), so every write here is idempotent:
 *   - decision logs: ON CONFLICT (stream_id, requested_at) DO NOTHING —
 *     the Redis Stream entry ID is the natural idempotency key
 *   - reports: an UPDATE by request_id is naturally idempotent
 * Billing data must never be double-counted; idempotence at the sink is what
 * turns at-least-once delivery into effectively-exactly-once accounting.
 */
import { Pool } from 'pg';

export interface LogRow {
  streamId: string;
  requestId: string;
  clientId: string;
  /** ms epoch of the decision. */
  ts: number;
  decisionLatencyMs: number;
  outcome: 'allowed' | 'denied';
  mode: string;
}

export interface ReportRow {
  requestId: string;
  upstreamResponseTimeMs: number;
  upstreamStatus: number;
}

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 5 });
}

/** Single multi-row INSERT per batch — one round trip for up to BATCH_SIZE rows. */
export async function insertLogBatch(pool: Pool, rows: LogRow[]): Promise<number> {
  if (rows.length === 0) return 0;

  const values: unknown[] = [];
  const tuples = rows.map((row, i) => {
    const base = i * 7;
    values.push(
      row.streamId,
      row.requestId,
      row.clientId,
      new Date(row.ts),
      row.decisionLatencyMs,
      row.outcome,
      row.mode,
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
  });

  const result = await pool.query(
    `INSERT INTO request_logs
       (stream_id, request_id, client_id, requested_at, decision_latency_ms, outcome, mode)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (stream_id, requested_at) DO NOTHING`,
    values,
  );
  return result.rowCount ?? 0;
}

/**
 * Applies an upstream outcome report to its original log row.
 * Returns false when the log row hasn't landed yet (report raced ahead of the
 * decision batch) — caller re-queues with a bounded attempt counter.
 */
export async function applyReport(pool: Pool, report: ReportRow): Promise<boolean> {
  const result = await pool.query(
    `UPDATE request_logs
        SET upstream_response_time_ms = $2,
            upstream_status = $3
      WHERE request_id = $1`,
    [report.requestId, report.upstreamResponseTimeMs, report.upstreamStatus],
  );
  return (result.rowCount ?? 0) > 0;
}
