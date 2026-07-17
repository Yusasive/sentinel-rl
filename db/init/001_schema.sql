-- Schema for the Global Rate Limiter analytics/billing store.
-- Runs automatically on first `docker compose up` (docker-entrypoint-initdb.d).

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ─────────────────────────────────────────────────────────────────────────────
-- Per-client rate limit configuration (FR1, FR7).
-- Postgres is the durable source of truth; dashboard-api syncs rows into
-- Redis hashes (ratelimit:config:{clientId}) so the hot path never touches
-- Postgres. Updates via PUT /config/:clientId take effect without redeploy.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE client_configs (
  client_id        TEXT PRIMARY KEY,
  name             TEXT        NOT NULL,
  limit_per_window INTEGER     NOT NULL CHECK (limit_per_window > 0),
  window_seconds   INTEGER     NOT NULL DEFAULT 60 CHECK (window_seconds > 0),
  -- Outage policy (TRD §5): what happens to this client when Redis is down.
  --   'open'   = bounded local fallback keeps traffic flowing (default)
  --   'closed' = deny during outage (for APIs where overage costs real money)
  on_outage        TEXT        NOT NULL DEFAULT 'open'
                               CHECK (on_outage IN ('open', 'closed')),
  -- Dashboard tenancy (TRD §7): key scopes dashboard queries to this client.
  api_key          TEXT        NOT NULL UNIQUE,
  is_admin         BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Request log (FR5). Written only by the log worker, in batches.
--
-- stream_id is the Redis Stream entry ID: delivery from the stream is
-- at-least-once, so it doubles as the idempotency key — replays after a
-- worker crash hit ON CONFLICT DO NOTHING instead of double-counting billing.
--
-- TimescaleDB constraint: every unique index must include the partition
-- column, hence the composite PK (a bare surrogate PK fails create_hypertable).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE request_logs (
  stream_id                 TEXT             NOT NULL,
  request_id                UUID             NOT NULL,
  client_id                 TEXT             NOT NULL,
  requested_at              TIMESTAMPTZ      NOT NULL,
  -- Decision latency: how long the rate-limit check itself took (always known).
  decision_latency_ms       DOUBLE PRECISION NOT NULL,
  -- Upstream metrics: the third-party API's actual outcome, reported
  -- after the fact by callers via POST /report. NULL until reported.
  upstream_response_time_ms INTEGER,
  upstream_status           INTEGER,
  outcome                   TEXT             NOT NULL
                                             CHECK (outcome IN ('allowed', 'denied')),
  -- 'normal' (atomic Redis decision) or 'fallback' (degraded local decision) —
  -- lets billing/ops distinguish authoritative counts from best-effort ones.
  mode                      TEXT             NOT NULL DEFAULT 'normal',
  PRIMARY KEY (stream_id, requested_at)
);

SELECT create_hypertable('request_logs', 'requested_at');

-- Dashboard queries are always "one client over a time range".
CREATE INDEX idx_logs_client_time ON request_logs (client_id, requested_at DESC);
-- POST /report correlates by request_id (UPDATE ... WHERE request_id = $1).
CREATE INDEX idx_logs_request_id ON request_logs (request_id);
