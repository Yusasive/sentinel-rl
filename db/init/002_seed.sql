-- Demo seed data (PRD example clients + test fixtures).
-- API keys are plain demo values — this system runs behind internal network
-- boundaries per the PRD; see README for the production note.

INSERT INTO client_configs
  (client_id, name, limit_per_window, window_seconds, on_outage, api_key, is_admin)
VALUES
  -- The two clients from the assignment brief:
  ('client-a', 'Client A — Banking API integration',   100, 60, 'open',   'key-client-a', FALSE),
  ('client-b', 'Client B — High-volume AI model',     5000, 60, 'open',   'key-client-b', FALSE),

  -- Demonstrates the per-client fail-CLOSED outage policy (TRD §5):
  -- overage on this API carries hard financial penalties, so during a Redis
  -- outage its traffic is denied rather than risked.
  ('bank-strict', 'Strict Bank — fail-closed on outage', 50, 60, 'closed', 'key-bank-strict', FALSE),

  -- Fixture for the deterministic race-condition test (150 requests vs 100).
  ('test-race-client', 'Race-condition test fixture',   100, 60, 'open',   'key-test-race', FALSE),

  -- Admin identity for config CRUD + cross-client dashboard access.
  -- limit is irrelevant (admin key is not used for /check).
  ('admin', 'Platform admin', 1000, 60, 'open', 'key-admin', TRUE);
