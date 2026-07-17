/**
 * Log worker: Redis Streams consumer → batched, idempotent Postgres writes.
 *
 * Reliability model (TRD §6.2):
 *  - Consumer GROUP created from ID 0, so entries added before the worker
 *    first started are still consumed (no boot-order coupling).
 *  - Stable consumer name (container hostname): after a crash, the worker
 *    first drains its own Pending Entries List (XREADGROUP with ID '0') —
 *    entries that were delivered but never XACKed — before reading new ones.
 *    This is the "kill the worker mid-consumption, lose nothing" guarantee
 *    the chaos test exercises.
 *  - XACK strictly AFTER the Postgres write commits. Crash between the two
 *    ⇒ redelivery ⇒ ON CONFLICT DO NOTHING absorbs the replay (db.ts).
 *  - Reports that arrive before their decision row landed are re-queued with
 *    a bounded attempt counter (they raced the decision batch).
 */
import Redis from 'ioredis';
import { hostname } from 'node:os';
import { createPool, insertLogBatch, applyReport, type LogRow } from './db';

const REQUEST_LOG_STREAM = 'request-log-stream';
const REPORT_STREAM = 'report-stream';
const GROUP = 'logworkers';
const MAX_REPORT_ATTEMPTS = 5;

const env = {
  redisHost: process.env.REDIS_HOST ?? 'localhost',
  redisPort: Number(process.env.REDIS_PORT ?? 6379),
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://ratelimiter:ratelimiter@localhost:5432/ratelimiter',
  batchSize: Number(process.env.BATCH_SIZE ?? 500),
  blockMs: Number(process.env.BLOCK_MS ?? 2000),
};

const consumerName = hostname(); // stable across restarts of the same container

// Blocking reads need their own connection; a second one handles acks/re-adds
// so they aren't stuck behind a BLOCK.
const redis = new Redis({ host: env.redisHost, port: env.redisPort, maxRetriesPerRequest: null });
const pool = createPool(env.databaseUrl);

type StreamEntry = [id: string, fields: string[]];

/** ['k1','v1','k2','v2'] → {k1: 'v1', k2: 'v2'} */
function fieldsToObject(fields: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i < fields.length - 1; i += 2) {
    const key = fields[i];
    const value = fields[i + 1];
    if (key !== undefined && value !== undefined) obj[key] = value;
  }
  return obj;
}

async function ensureGroups(): Promise<void> {
  for (const stream of [REQUEST_LOG_STREAM, REPORT_STREAM]) {
    try {
      // ID 0 = consume from the beginning; MKSTREAM creates an empty stream
      // so the worker can start before the first decision is ever logged.
      await redis.xgroup('CREATE', stream, GROUP, '0', 'MKSTREAM');
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) throw err;
      // Group already exists — normal on every restart.
    }
  }
}

async function processLogEntries(entries: StreamEntry[]): Promise<void> {
  const rows: LogRow[] = [];
  const ids: string[] = [];

  for (const [id, fields] of entries) {
    const f = fieldsToObject(fields);
    if (!f.requestId || !f.clientId || !f.ts || !f.outcome) {
      ids.push(id); // malformed entry: ack it away rather than poison the loop
      continue;
    }
    rows.push({
      streamId: id,
      requestId: f.requestId,
      clientId: f.clientId,
      ts: Number(f.ts),
      decisionLatencyMs: Number(f.decisionLatencyMs ?? 0),
      outcome: f.outcome === 'denied' ? 'denied' : 'allowed',
      mode: f.mode ?? 'normal',
    });
    ids.push(id);
  }

  // Write first, ack second — the order the durability guarantee depends on.
  await insertLogBatch(pool, rows);
  if (ids.length > 0) await redis.xack(REQUEST_LOG_STREAM, GROUP, ...ids);
}

async function processReportEntries(entries: StreamEntry[]): Promise<void> {
  for (const [id, fields] of entries) {
    const f = fieldsToObject(fields);
    const attempts = Number(f.attempts ?? 0);

    if (f.requestId && f.upstreamResponseTimeMs !== undefined) {
      const applied = await applyReport(pool, {
        requestId: f.requestId,
        upstreamResponseTimeMs: Number(f.upstreamResponseTimeMs),
        upstreamStatus: Number(f.upstreamStatus ?? 0),
      });
      if (!applied && attempts < MAX_REPORT_ATTEMPTS) {
        // Decision row not in Postgres yet — requeue; the attempt cap turns
        // "report for a request that never existed" into a bounded retry,
        // not an infinite loop.
        await redis.xadd(
          REPORT_STREAM, '*',
          'requestId', f.requestId,
          'upstreamResponseTimeMs', f.upstreamResponseTimeMs,
          'upstreamStatus', f.upstreamStatus ?? '0',
          'attempts', String(attempts + 1),
        );
      }
    }
    await redis.xack(REPORT_STREAM, GROUP, id);
  }
}

/**
 * Reads one batch from a stream. id='0' reads this consumer's own pending
 * (unacked) entries — the crash-recovery pass; id='>' reads new entries.
 */
async function readBatch(stream: string, id: '0' | '>', block: boolean): Promise<StreamEntry[]> {
  const args = block
    ? (['GROUP', GROUP, consumerName, 'COUNT', env.batchSize, 'BLOCK', env.blockMs,
       'STREAMS', stream, id] as const)
    : (['GROUP', GROUP, consumerName, 'COUNT', env.batchSize, 'STREAMS', stream, id] as const);
  const reply = (await redis.xreadgroup(...(args as unknown as Parameters<typeof redis.xreadgroup>))) as
    | [string, StreamEntry[]][]
    | null;
  return reply?.[0]?.[1] ?? [];
}

async function drainOwnPending(): Promise<void> {
  // Replay anything delivered to this consumer name but never acked.
  for (;;) {
    const entries = await readBatch(REQUEST_LOG_STREAM, '0', false);
    if (entries.length === 0) break;
    console.log(`[logworker] replaying ${entries.length} pending decision entries`);
    await processLogEntries(entries);
  }
  for (;;) {
    const entries = await readBatch(REPORT_STREAM, '0', false);
    if (entries.length === 0) break;
    await processReportEntries(entries);
  }
}

async function main(): Promise<void> {
  await ensureGroups();
  await drainOwnPending();
  console.log(`[logworker] consuming as '${consumerName}' (batch=${env.batchSize})`);

  for (;;) {
    try {
      // Block on the decision stream (the volume driver); poll reports after.
      const logs = await readBatch(REQUEST_LOG_STREAM, '>', true);
      if (logs.length > 0) await processLogEntries(logs);

      const reports = await readBatch(REPORT_STREAM, '>', false);
      if (reports.length > 0) await processReportEntries(reports);
    } catch (err) {
      // Redis or Postgres hiccup: log, back off, retry. Unacked entries are
      // redelivered, the sink is idempotent — nothing is lost either way.
      console.error('[logworker] batch failed, retrying in 1s:', (err as Error).message);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

void main().catch((err) => {
  console.error('[logworker] fatal:', err);
  process.exit(1);
});
