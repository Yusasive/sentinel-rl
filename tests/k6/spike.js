/**
 * Spike test (TRD §10.3): sudden 10× traffic burst. Verifies graceful
 * behavior — no crashes, no error explosion, bounded latency growth — while
 * the limiter sheds over-quota load by denying (which is its job).
 *
 * Run: docker compose --profile test run --rm k6 run /scripts/spike.js
 */
import http from 'k6/http';
import { check } from 'k6';

const TARGET = __ENV.TARGET_URL || 'http://localhost:8080';

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-arrival-rate',
      startRate: 20,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: 500,
      stages: [
        { target: 20, duration: '20s' },  // baseline
        { target: 400, duration: '10s' }, // sudden spike
        { target: 400, duration: '30s' }, // hold the spike
        { target: 20, duration: '10s' },  // recover
        { target: 20, duration: '20s' },  // steady again
      ],
    },
  },
  thresholds: {
    // Under spike we allow more headroom, but latency must stay bounded and
    // the service must keep answering — deny is fine, error is not.
    http_req_duration: ['p(99)<50'],
    http_req_failed: ['rate<0.01'],
  },
};

const payload = JSON.stringify({ clientId: 'client-b' });
const params = { headers: { 'Content-Type': 'application/json' } };

export default function () {
  const response = http.post(`${TARGET}/check`, payload, params);
  check(response, {
    'answered (200)': (r) => r.status === 200,
  });
}
