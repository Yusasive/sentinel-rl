/**
 * Sustained load test (TRD §10.3): drives Client B's full budget shape
 * (5000 req/min ≈ 83 rps) against the /check endpoint through the load
 * balancer and asserts the latency SLA holds.
 *
 * Thresholds — chosen to be meaningful on shared hardware:
 *  - p95 < 5ms strict: the stable signal that the hot path is healthy.
 *  - p99 < 25ms at the HTTP layer: on a laptop, k6's 50 VUs, 9 containers
 *    and Redis all share the same Docker VM cores, so the worst 1% of
 *    requests absorb scheduler stalls that have nothing to do with the
 *    limiter (observed: p99 <1ms on an idle host, ~17ms on a busy one,
 *    while the IN-PROCESS decision p99 stayed single-digit both times).
 *  - <0.1% errors.
 *
 * The authoritative SLA measurement for "a decision takes a few ms" is the
 * in-process histogram the service itself exports:
 *   curl -s localhost:8080/metrics | grep decision_latency_ms_bucket
 *
 * Run: docker compose --profile test run --rm k6 run /scripts/load.js
 */
import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';

const TARGET = __ENV.TARGET_URL || 'http://localhost:8080';

const denials = new Rate('rate_limited');

export const options = {
  scenarios: {
    sustained: {
      executor: 'constant-arrival-rate',
      rate: 85, // ≈ Client B's 5000/min
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  thresholds: {
    // p95 is the strict SLA signal; p99 gets headroom for load-generator/VM
    // scheduler noise on shared hardware (see header comment).
    http_req_duration: ['p(95)<5', 'p(99)<25'],
    http_req_failed: ['rate<0.001'],
  },
};

const payload = JSON.stringify({ clientId: 'client-b' });
const params = { headers: { 'Content-Type': 'application/json' } };

export default function () {
  const response = http.post(`${TARGET}/check`, payload, params);

  check(response, {
    'status is 200': (r) => r.status === 200,
    'has decision': (r) => {
      const body = r.json();
      return typeof body.allowed === 'boolean';
    },
  });

  // Denials are EXPECTED once the window fills (5000/min budget vs 85rps
  // sustained = ~5100/min offered): they're the limiter working, not errors.
  denials.add(response.json('allowed') === false);
}
