/**
 * Race-condition test (TRD §10.2) — the core correctness proof.
 *
 * Fires TOTAL_REQUESTS (150) truly concurrent /check calls for a client with
 * limit 100/window THROUGH THE LOAD BALANCER, so requests land on all three
 * rate-limiter instances at once. Asserts EXACTLY 100 allowed and 50 denied —
 * no more, no fewer. Any non-atomic read-check-increment implementation fails
 * this test (both concurrent requests read 99 and both get allowed).
 *
 * Determinism precondition (TRD §4.2 approximation boundary): the sliding
 * window counter weights the PREVIOUS window, so exact-count assertions are
 * only valid inside a fresh window with an empty previous window. Therefore:
 *   1. we wait until enough of the current window remains to finish the burst;
 *   2. we delete the client's current+previous counter keys — a clean slate,
 *      making the estimate degenerate to the exact current count.
 *
 * Also validates that the responses came from multiple distinct instances
 * (via each instance's /health-reported ID being irrelevant here, we instead
 * assert distribution by hitting /health through the LB) — a race test that
 * accidentally ran against one instance would prove much less.
 */
import Redis from 'ioredis';

const TARGET_URL = process.env.TARGET_URL ?? 'http://localhost:8080';
const REDIS_HOST = process.env.REDIS_HOST ?? 'localhost';
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);
const CLIENT_ID = process.env.CLIENT_ID ?? 'test-race-client';
const TOTAL_REQUESTS = Number(process.env.TOTAL_REQUESTS ?? 150);

// Must match the seeded config for CLIENT_ID (db/init/002_seed.sql).
const EXPECTED_LIMIT = 100;
const WINDOW_SECONDS = 60;

// Key scheme must mirror services/ratelimiter/src/redis/client.ts.
const counterKey = (win) => `ratelimit:{${CLIENT_ID}}:${win}`;

function fail(message) {
  console.error(`\n[FAIL] RACE TEST FAILED: ${message}`);
  process.exit(1);
}

async function waitForStack() {
  // The stack may still be booting (compose starts us alongside it).
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${TARGET_URL}/health`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  fail('stack did not become healthy within 30s');
}

async function verifyMultipleInstances() {
  // Sample /health through the LB; least_conn across idle instances should
  // reach all three. This guards against a misconfigured LB silently turning
  // this into a single-instance test.
  const seen = new Set();
  for (let i = 0; i < 30; i += 1) {
    const response = await fetch(`${TARGET_URL}/health`);
    const body = await response.json();
    seen.add(body.instanceId);
    if (seen.size >= 2) return seen;
  }
  return seen;
}

async function main() {
  console.log(`Race test: ${TOTAL_REQUESTS} concurrent requests vs limit ${EXPECTED_LIMIT}`);
  console.log(`Target: ${TARGET_URL} (via load balancer), client: ${CLIENT_ID}\n`);

  await waitForStack();

  const instances = await verifyMultipleInstances();
  console.log(`Instances seen through LB: ${[...instances].join(', ')}`);
  if (instances.size < 2) {
    fail('requests are not being distributed across multiple instances');
  }

  const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });

  // ── Determinism precondition ─────────────────────────────────────────────
  // Redis server time decides the window (the Lua script uses TIME), so use
  // Redis time — not local time — to measure how much window remains.
  const [seconds] = await redis.time();
  const nowSec = Number(seconds);
  const windowStart = Math.floor(nowSec / WINDOW_SECONDS) * WINDOW_SECONDS;
  const remaining = WINDOW_SECONDS - (nowSec - windowStart);
  if (remaining < 20) {
    console.log(`Only ${remaining}s left in the current window — waiting for a fresh one…`);
    await new Promise((resolve) => setTimeout(resolve, (remaining + 1) * 1000));
  }

  const [afterSec] = await redis.time();
  const win = Math.floor(Number(afterSec) / WINDOW_SECONDS);
  await redis.del(counterKey(win), counterKey(win - 1));
  console.log('Counter keys reset — fresh window, empty previous window.\n');

  // ── Fire all requests truly concurrently ────────────────────────────────
  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: TOTAL_REQUESTS }, async () => {
      const response = await fetch(`${TARGET_URL}/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: CLIENT_ID }),
      });
      if (!response.ok) {
        fail(`unexpected HTTP ${response.status} from /check`);
      }
      return response.json();
    }),
  );
  const elapsedMs = Date.now() - started;

  const allowed = results.filter((r) => r.allowed).length;
  const denied = results.filter((r) => !r.allowed).length;
  const fallbackDecisions = results.filter((r) => r.mode === 'fallback').length;

  console.log(`Completed ${TOTAL_REQUESTS} requests in ${elapsedMs}ms`);
  console.log(`Allowed: ${allowed}, Denied: ${denied}, Fallback-mode: ${fallbackDecisions}`);

  // ── Assertions ──────────────────────────────────────────────────────────
  if (fallbackDecisions > 0) {
    fail(`${fallbackDecisions} decisions came from fallback mode — Redis was degraded; ` +
      'the atomicity assertion only applies to normal mode. Re-run with Redis healthy.');
  }
  if (allowed !== EXPECTED_LIMIT) {
    fail(`expected EXACTLY ${EXPECTED_LIMIT} allowed, got ${allowed} — ` +
      (allowed > EXPECTED_LIMIT
        ? 'over-admission: the check-and-increment is NOT atomic under concurrency!'
        : 'under-admission: requests were lost or double-counted.'));
  }
  if (denied !== TOTAL_REQUESTS - EXPECTED_LIMIT) {
    fail(`expected ${TOTAL_REQUESTS - EXPECTED_LIMIT} denied, got ${denied}`);
  }

  // Sanity: denied responses must carry a retry hint.
  const deniedWithoutRetry = results.filter((r) => !r.allowed && !(r.retryAfterMs > 0)).length;
  if (deniedWithoutRetry > 0) {
    fail(`${deniedWithoutRetry} denied responses missing retryAfterMs`);
  }

  console.log(`\n[PASS] RACE TEST PASSED: exactly ${EXPECTED_LIMIT} allowed / ` +
    `${TOTAL_REQUESTS - EXPECTED_LIMIT} denied across ${instances.size}+ instances — ` +
    'atomicity holds under concurrent, cross-instance load.');
  redis.disconnect();
  process.exit(0);
}

main().catch((err) => fail(err.message));
