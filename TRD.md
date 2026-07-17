# Technical Requirements Document (TRD)
## Global Rate Limiter as a Service

**Version:** 1.1
**Status:** Draft
**Related:** PRD.md
**Changelog:** v1.1 — fixed TimescaleDB PK constraint, defined response-time semantics via `POST /report`, idempotent log ingestion, Lua script returns full decision tuple + reads config in-script + uses Redis TIME, in-memory config snapshot for fallback, per-client outage policy, Sentinel chosen explicitly, hash-tag note, AOF persistence.

---

## 1. Purpose
This document defines the concrete technical design for the Global Rate Limiter service described in PRD.md — the architecture, technology choices, data models, algorithms, failure handling, and testing strategy required to implement it.

---

## 2. High-Level Architecture

```
                         ┌─────────────────────────┐
                         │   Internal Microservices  │
                         │  (N instances, any count) │
                         └────────────┬──────────────┘
                                      │ HTTP/gRPC: POST /check
                                      ▼
                     ┌────────────────────────────────┐
                     │        Load Balancer (Nginx)     │
                     └────────────────┬─────────────────┘
                                      │
             ┌────────────────────────┼────────────────────────┐
             ▼                        ▼                        ▼
    ┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
    │ Rate Limiter #1  │      │ Rate Limiter #2  │      │ Rate Limiter #N  │
    │ (stateless)      │      │ (stateless)      │      │ (stateless)      │
    │ + local fallback │      │ + local fallback │      │ + local fallback │
    │   token bucket   │      │   token bucket   │      │   token bucket   │
    └────────┬─────────┘      └────────┬─────────┘      └────────┬─────────┘
             │        Atomic Lua EVAL (check + increment)          │
             └────────────────────────┬─────────────────────────────┘
                                      ▼
                     ┌────────────────────────────────┐
                     │       Redis (Sentinel HA)        │  ◄── Hot path, source of truth
                     │  Sliding-window counters/client  │
                     └────────────────┬─────────────────┘
                                      │ XADD (async, fire-and-forget)
                                      ▼
                     ┌────────────────────────────────┐
                     │        Redis Stream (log)        │
                     └────────────────┬─────────────────┘
                                      │ consumer group
                                      ▼
                     ┌────────────────────────────────┐
                     │     Log Worker (batch writer)    │
                     └────────────────┬─────────────────┘
                                      ▼
                     ┌────────────────────────────────┐
                     │   PostgreSQL (+ TimescaleDB)     │  ◄── Analytics/billing store
                     │   request_logs, aggregates        │
                     └────────────────┬─────────────────┘
                                      ▼
                     ┌────────────────────────────────┐
                     │   Dashboard API + React Frontend │
                     └────────────────────────────────┘
```

### 2.1 Component Summary
| Component | Responsibility |
|---|---|
| **Rate Limiter Service** | Stateless HTTP/gRPC service. Receives `check` requests, executes atomic Redis Lua script, returns allow/deny. Falls back to local in-memory limiter if Redis is unreachable. Keeps a periodically refreshed in-memory snapshot of all client configs so fallback works even when both Redis and Postgres are down. |
| **Redis (Sentinel)** | Source of truth for real-time counters. Provides atomicity via Lua scripting. HA via Sentinel (3 sentinels + primary/replica). Redis Cluster is documented as a future scale-out path, not implemented here. |
| **Redis Stream** | Lightweight async queue for approved-request events, decoupling logging from the hot path. |
| **Log Worker** | Consumes the stream in batches, writes to Postgres. Independently scalable/restart-safe via consumer groups. |
| **PostgreSQL (+ TimescaleDB)** | Durable store for analytics/billing queries — trend graphs, averages, filters. |
| **Dashboard API** | Read-only API querying Postgres for usage/trend data, serving the frontend. |
| **Dashboard Frontend (React)** | Visualizes real-time and historical usage with filters and graphs. |
| **Admin/Config API** | CRUD for per-client rate limit configuration, stored in Postgres (and cached/synced into Redis for fast lookups). |

---

## 3. Technology Stack

| Layer | Choice | Rationale |
|---|---|---|
| Service language | Node.js + TypeScript (Express/Fastify) | Fast to build, strong Redis client ecosystem, easy to test |
| Hot-path store | Redis 7.x (AOF enabled: `appendonly yes`) | Sub-ms in-memory ops, native Lua scripting for atomicity, TTL support. AOF persistence is required so the log stream (Section 6) survives a Redis restart — without it the "100% of approved requests logged" guarantee doesn't hold. |
| HA for Redis | Redis Sentinel (3 nodes) | Automatic failover for local/dev-scale HA demonstration |
| Async transport | Redis Streams | Avoids adding a second infra dependency (e.g., Kafka) while still decoupling logging from the hot path |
| Analytics DB | PostgreSQL 15 + TimescaleDB extension | Strong aggregation/query support for trend graphs; TimescaleDB optimizes time-bucketed queries |
| Dashboard frontend | React + Recharts | Simple, well-understood charting for trend graphs |
| Load balancer | Nginx | Simulates multi-instance cluster routing in Docker Compose |
| Containerization | Docker + Docker Compose | Single-command spin-up of the full stack |
| Testing | Jest (unit + race condition), k6 (load/performance) | Jest covers logic and concurrency; k6 covers latency/throughput under load |

---

## 4. Rate Limiting Algorithm

**Chosen approach: Sliding Window Counter** (weighted average of current + previous fixed window)

Rationale:
- More accurate than fixed window (avoids burst-at-boundary problem, e.g., 2x traffic at the edge of two windows).
- Cheaper than sliding window log (doesn't store a timestamp per request — critical at 5000 req/min scale).
- Simple to implement atomically in a single Redis Lua script.

### 4.1 Data Model (Redis)
```
Key:    ratelimit:{clientId}:{currentWindowEpoch}
Value:  integer counter (INCR)
TTL:    window size * 2 (to allow the "previous window" to still be read)

Key:    ratelimit:config:{clientId}
Value:  hash { limit: <int>, windowSeconds: <int>, onOutage: "open"|"closed" }
```

> **Hash-tag note (deliberate, not incidental):** the `{clientId}` braces in the key are a Redis hash tag. All keys for one client — current window, previous window, config — therefore hash to the same slot. Multi-key Lua scripts *require* co-located keys under Redis Cluster, so this key scheme keeps the design portable to Cluster later without a rewrite.

### 4.2 Atomic Check-and-Increment (Lua, pseudocode)

Design decisions baked into the script:
- **Config is read inside the script** (same hash slot), so a decision costs exactly **one** Redis round trip — no separate config `GET` per check.
- **Time comes from `redis.call('TIME')`**, not the app server clock. With multiple limiter instances in containers, clock skew would make instances disagree about which window is "current", silently breaking cross-instance accuracy — the core guarantee of this system. Using Redis's clock gives every instance the same time source. (This makes the script non-deterministic; Redis 7's default effects-based replication handles this correctly.)
- The script **returns the full decision tuple** `{allowed, remaining, retryAfterMs}` so the API contract in Section 8 is satisfied in that single round trip.

```lua
-- KEYS[1] = config key        (ratelimit:config:{clientId})
-- ARGV[1] = key prefix        (ratelimit:{clientId}:)
-- No limit/window passed from the app: config is the single source of truth.

local limit  = tonumber(redis.call('HGET', KEYS[1], 'limit'))
local window = tonumber(redis.call('HGET', KEYS[1], 'windowSeconds'))
if not limit then return {-1, 0, 0} end  -- unknown client: app maps to 404/deny

local time = redis.call('TIME')                 -- {seconds, microseconds}
local now = tonumber(time[1]) + tonumber(time[2]) / 1e6
local currentWindow  = math.floor(now / window)
local elapsed = (now - currentWindow * window) / window   -- 0.0 - 1.0

local currKey = ARGV[1] .. currentWindow
local prevKey = ARGV[1] .. (currentWindow - 1)

local current  = tonumber(redis.call('GET', currKey) or "0")
local previous = tonumber(redis.call('GET', prevKey) or "0")

local estimated = previous * (1 - elapsed) + current

if estimated >= limit then
  local retryAfterMs = math.ceil((1 - elapsed) * window * 1000)
  return {0, 0, retryAfterMs}                   -- denied
else
  redis.call('INCR', currKey)
  redis.call('EXPIRE', currKey, window * 2)
  local remaining = math.max(0, math.floor(limit - estimated - 1))
  return {1, remaining, 0}                      -- allowed
end
```

This script executes as a single atomic operation in Redis, which is what prevents the race condition where two concurrent requests both read "99/100" and both get allowed — the read-check-increment happens indivisibly from Redis's perspective, even under concurrent access from multiple rate-limiter instances.

> **Approximation boundary (matters for testing):** the sliding window counter weights the *previous* window by the elapsed fraction — it is an estimate, not an exact count. Within a single fresh window (empty previous window) it is exact, which is what makes the deterministic race-condition assertion in Section 10.2 valid.

---

## 5. Fail-Safe Strategy (Redis/DB Unavailability)

**Chosen approach: Fail-open by default, with a bounded local fallback and a per-client policy override**

1. Every outbound call to Redis from the rate-limiter service is wrapped with a short timeout (e.g., 50ms) and a circuit breaker.
2. **Config availability is a hidden dependency of fallback mode** — the local limiter needs each client's configured limit, but config lives in Postgres and is cached in Redis, i.e., exactly the stores that are down when fallback activates. Therefore every instance maintains an **in-memory, periodically refreshed snapshot of all client configs** (last-known-good, refreshed every ~30s during normal operation). Fallback reads limits from this snapshot, never from the network.
3. If Redis is unreachable or the circuit is open, behavior depends on the client's configured outage policy (`onOutage` in the config hash):
   - **`open` (default):** the instance switches to a **local in-memory token bucket**, seeded conservatively (a fraction of the client's configured limit, divided by the expected instance count — `INSTANCE_COUNT` env var) to reduce — not eliminate — the risk of exceeding the real quota during the outage. Deliberate trade-off: brief, bounded risk of minor over-quota vs. blocking all business traffic.
   - **`closed`:** all requests for this client are denied while degraded. This exists because for some APIs (e.g., banking providers with hard financial penalties for overage) blocking traffic is *cheaper* than exceeding quota. The outage trade-off is a per-client product decision, not a global constant.
4. The circuit breaker periodically probes Redis and switches back to normal mode once it recovers.
5. All fallback activations are logged/alerted so ops teams are aware degraded mode is active, and surfaced via `/health` and metrics.
6. This trade-off and its parameters (timeout, fallback fraction, per-client policy, snapshot refresh interval) must be documented in the README as an explicit, tunable decision — not hidden behavior.

---

## 6. Async Logging Pipeline

### 6.1 What "response time" means (two distinct metrics)

The rate limiter cannot know the third-party API's response time at decision moment — the downstream call hasn't happened yet. The system therefore records **two explicitly separate metrics**:

1. **`decisionLatencyMs`** — how long the rate-limit check itself took. Measured by the limiter, logged on every decision (allowed *and* denied — denied decisions are logged too, for observability and retry-pattern analysis, beyond the spec's minimum).
2. **`upstreamResponseTimeMs`** — the actual third-party API response time. The limiter can't observe this, so `POST /check` returns a `requestId` (the Redis Stream entry ID), and callers *optionally* report the outcome afterward via `POST /report { requestId, upstreamResponseTimeMs, upstreamStatus }`. Reports are joined to the original log entry by the worker. Dashboard "average response time" uses this metric where reported, and clearly labels coverage.

### 6.2 Pipeline

- On every decision, the rate-limiter service performs a non-blocking `XADD` to a Redis Stream (`request-log-stream`) with `{clientId, timestamp, decisionLatencyMs, outcome}`. This call does not block the response to the caller — it's fire-and-forget with a short internal timeout, and failures here are logged but never fail the rate-limit decision itself.
- A separate **Log Worker** process (independently scaled) consumes the stream via a consumer group, batches records, and writes them to PostgreSQL, `XACK`ing only after a successful commit.
- **Delivery semantics are at-least-once, not exactly-once** — if a worker crashes after the DB write but before `XACK`, the batch is redelivered. Deduplication is handled at the sink: the Redis Stream **entry ID is stored as a unique column** and inserts use `ON CONFLICT (stream_id) DO NOTHING`, making ingestion idempotent. (Billing data must never be double-counted; "consumer groups prevent duplicates" alone would be a false claim.)
- Durability: Redis runs with AOF enabled so buffered stream entries survive a Redis restart. Residual gap (documented): entries fsynced within the last second can be lost on a hard crash with `appendfsync everysec`.

### 6.3 Postgres Schema (simplified)
```sql
CREATE TABLE request_logs (
  stream_id     TEXT NOT NULL,           -- Redis Stream entry ID; idempotency key
  client_id     TEXT NOT NULL,
  requested_at  TIMESTAMPTZ NOT NULL,
  decision_latency_ms      INTEGER NOT NULL,
  upstream_response_time_ms INTEGER,     -- NULL until/unless caller reports via POST /report
  upstream_status           INTEGER,     -- ditto
  outcome       TEXT NOT NULL,           -- 'allowed' | 'denied'
  -- TimescaleDB constraint: every unique index must include the partition
  -- column, so the PK is composite (a bare surrogate PK fails create_hypertable).
  PRIMARY KEY (stream_id, requested_at)
);

-- TimescaleDB hypertable for efficient time-bucketed queries
SELECT create_hypertable('request_logs', 'requested_at');

CREATE INDEX idx_logs_client_time ON request_logs (client_id, requested_at DESC);
```

---

## 7. Dashboard API

| Endpoint | Description |
|---|---|
| `GET /usage/:clientId/current` | Real-time usage vs. configured limit |
| `GET /usage/:clientId/trend?days=10\|15\|30` | Time-bucketed request counts and average response time over the window |
| `GET /usage/:clientId/filter?metric=avgResponseTime&from=&to=` | Filtered/aggregated queries |
| `GET /config/:clientId` | Current rate limit configuration |
| `PUT /config/:clientId` | Update rate limit configuration (admin) |

Trend queries use TimescaleDB `time_bucket()` for efficient aggregation (e.g., daily buckets over 30 days).

**Tenancy:** dashboard requests carry a per-client API key (`X-API-Key` header). The key resolves to a `clientId`, and all usage queries are scoped to it — Client A cannot read Client B's usage or spend. Admin keys (config CRUD, cross-client views) are a separate key class. This is deliberately simple (keys seeded in Postgres, checked by middleware) since the system runs behind internal network boundaries per the PRD.

---

## 8. Rate Limiter Service API

| Endpoint | Description |
|---|---|
| `POST /check` | Body: `{ clientId }`. Returns `{ allowed: boolean, remaining: number, retryAfterMs?: number, requestId: string }`. The full tuple comes from the single Lua round trip (Section 4.2); `requestId` is the log-stream entry ID, used to correlate an optional `POST /report`. Target p99 latency: a few ms. |
| `POST /report` | Body: `{ requestId, upstreamResponseTimeMs, upstreamStatus }`. Optional post-hoc report of the actual third-party call outcome (see Section 6.1). Async, off the hot path. |
| `GET /health` | Liveness/readiness, including current Redis connection state (normal vs. fallback mode). |

---

## 9. Concurrency & Correctness Guarantees
- Atomicity of check-and-increment is guaranteed by Redis's single-threaded command execution combined with Lua script execution (the whole script runs as one atomic unit).
- No distributed lock is needed for the common path — this is a deliberate design choice to keep latency low; the Lua script *is* the concurrency control.
- Correctness under concurrent, multi-instance access is explicitly verified via race-condition tests (see Section 10).

---

## 10. Testing Strategy

### 10.1 Unit Tests
- Rate limit config CRUD logic
- Sliding window calculation edge cases (window boundaries, TTL expiry)
- Fallback activation/deactivation logic (circuit breaker transitions)

### 10.2 Race Condition Tests
- Spin up N concurrent requests (e.g., 150) against a client configured for a limit of 100/window, from multiple parallel workers/threads, hitting multiple rate-limiter instances behind the load balancer.
- Assert exactly 100 are allowed and 50 are denied — no more, no fewer — proving atomicity holds under real concurrent, cross-instance load.
- **Determinism precondition:** the exact-count assertion is only valid inside a *fresh* window with an empty previous window — the sliding window counter weights the previous window, so a non-empty one makes the effective limit an estimate (Section 4.2). The test therefore flushes the client's counter keys and waits for a window boundary before firing, and documents why in a comment.

### 10.3 Load & Performance Tests (k6)
- Sustained load test at target throughput (e.g., simulating Client B's 5000 req/min) asserting p99 latency stays within the few-ms SLA.
- Spike test to confirm graceful behavior (no crashes, bounded latency growth) under sudden traffic bursts.

### 10.4 Edge Case / Chaos Tests
- Kill the Redis container mid-test; assert traffic continues to flow via fallback mode rather than being fully blocked.
- Restart Redis; assert the service detects recovery and resumes normal atomic checking.
- Kill the Log Worker mid-stream-consumption; assert no log entries are lost after restart (consumer group replay).

---

## 11. Deployment (Docker Compose)

Services defined in `docker-compose.yml`:
- `nginx` (load balancer)
- `ratelimiter` (scaled to 3 replicas)
- `redis` (+ optional sentinel nodes for HA demo)
- `logworker`
- `postgres` (with TimescaleDB image)
- `dashboard-api`
- `dashboard-frontend`

Single command: `docker compose up --build` brings up the entire stack, including seed configuration for at least two demo clients (matching the PRD example: Client A @ 100 req/min, Client B @ 5000 req/min).

---

## 12. Metrics & Observability
- Expose Prometheus-style metrics: request count, allow/deny count, p50/p95/p99 latency, fallback-mode activations.
- `/health` endpoint reflects current operating mode (normal vs. degraded).

---

## 13. Risks & Trade-offs
| Risk | Mitigation |
|---|---|
| Fallback mode allows temporary over-quota | Bounded, conservative local limit; per-client `onOutage: closed` override for penalty-sensitive APIs; alerting on activation; documented as explicit trade-off |
| Redis Streams less robust than Kafka for very high throughput | Acceptable for this scope; documented as a future swap-in if throughput requirements grow |
| Sliding window counter is an approximation, not perfectly precise | Accuracy trade-off explicitly chosen over sliding-log's memory cost; documented in README |
| Log delivery is at-least-once (worker crash between DB write and XACK) | Idempotent sink: stream entry ID unique column + `ON CONFLICT DO NOTHING` |
| Hard Redis crash can lose ≤1s of buffered log entries (`appendfsync everysec`) | AOF enabled; residual window documented; acceptable for this scope vs. fsync-per-write latency cost |
| `upstreamResponseTimeMs` coverage depends on callers using `POST /report` | Dashboard labels response-time metrics with report coverage; decision latency is always measured |

---

## 14. Deliverables Checklist (from requirement.md)

Tracked here so nothing is discovered missing at submission time:

- [ ] Complete solution in one ZIP file
- [ ] **Architecture diagram as an image file (JPG/JPEG/PNG)** — the ASCII diagram in Section 2 does not satisfy this; export a rendered diagram
- [ ] Detailed commented code
- [ ] Unit tests + race-condition tests (Section 10.1–10.2)
- [ ] Load & performance tests, k6 (Section 10.3)
- [ ] Chaos/edge-case tests (Section 10.4)
- [ ] `Dockerfile` + `docker-compose.yml` — full stack via single `docker compose up --build`, including seed data (Client A @ 100 req/min, Client B @ 5000 req/min)
- [ ] `README.md` — run instructions, how to trigger each test class, how to verify edge cases, fail-safe trade-off documentation (Section 5.6)

---

*See PRD.md for the corresponding product requirements and success criteria.*
