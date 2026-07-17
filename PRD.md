# Product Requirements Document (PRD)
## Global Rate Limiter as a Service

**Version:** 1.1
**Status:** Draft
**Owner:** Engineering Team
**Changelog:** v1.1 — defined response-time semantics (decision latency vs. caller-reported upstream time), per-client outage policy in FR4, denied-request logging included, resolved all open questions.

---

## 1. Overview

### 1.1 Problem Statement
The company integrates with hundreds of external third-party APIs (banking services, logistics providers, AI models), most of which enforce strict rate quotas tied directly to pricing and availability. Each internal microservice currently manages its own rate limiting in isolation. When a service is scaled horizontally (e.g., 10 running instances), every instance assumes it owns the *entire* quota for a given third-party API, rather than sharing it. This causes:

- Frequent `429 Too Many Requests` responses from third-party providers
- Unnecessary financial penalties from providers who bill for quota overages
- Inconsistent, duplicated rate-limiting logic scattered across services
- No centralized visibility into usage patterns or spend

### 1.2 Vision
A single, centralized, highly available **Rate Limiter Service** that all internal microservices consult before calling a third-party API. It enforces a global, cluster-wide quota per client/API, regardless of how many instances of the calling service (or the rate limiter itself) are running — while remaining fast enough to sit on the hot path of every outbound API call, and resilient enough to never become a single point of failure for the business.

### 1.3 Goals
- Eliminate quota-related `429` errors and associated financial penalties caused by uncoordinated multi-instance usage.
- Provide a single source of truth for "can I make this request right now?" across the entire cluster.
- Give each client/API team real-time and historical visibility into their usage via a dashboard.
- Keep the rate-limiting decision path extremely fast and available, even under partial infrastructure failure.

### 1.4 Non-Goals
- This service does not manage authentication/authorization to the third-party APIs themselves.
- This service does not retry or queue failed requests on behalf of callers — it only tells them whether to proceed.
- This service is not responsible for the business logic of what happens after a request is denied (callers decide: retry, queue, fail).

---

## 2. Users & Use Cases

### 2.1 Primary Users
| User | Description |
|---|---|
| **Internal Microservices** | Any service that needs to call a rate-limited third-party API (banking, logistics, AI models). Interacts via SDK/API call before every outbound request. |
| **Platform/Ops Engineers** | Configure per-client limits, monitor system health, respond to incidents. |
| **Client/Product Teams** | View usage dashboards to understand consumption, spot trends, and plan capacity or budget. |
| **Finance/Billing Stakeholders** | Use logged usage data for cost analysis and billing reconciliation. |

### 2.2 Key Use Cases
1. **As a microservice**, before calling the "Logistics Provider X" API, I check with the Rate Limiter whether I'm within quota, so I don't get billed for/blocked by overages.
2. **As a platform engineer**, I configure that "Client A" (e.g., a specific banking API integration) is limited to 100 requests/minute, and "Client B" (a high-volume AI model) is limited to 5000 requests/minute.
3. **As a platform engineer**, I need the rate limiter to keep working correctly even when 10 instances of a calling service are running simultaneously and all hitting it concurrently.
4. **As an ops engineer**, if Redis or the database goes down temporarily, I need the system to fail in a way that doesn't halt all business traffic.
5. **As a client team member**, I want to see a dashboard of my real-time usage, with filters for average response time and trend graphs over the last 10, 15, or 30 days, so I can understand my consumption patterns.
6. **As a finance stakeholder**, I need every approved request logged reliably so it can be used for billing reconciliation, even though this logging must never slow down the actual rate-limit decision.

---

## 3. Functional Requirements

### FR1 — Per-Client Configurable Limits
The system must support distinct rate limits per client (e.g., Client A: 100 req/min, Client B: 5000 req/min). Limits must be configurable without redeploying the service.

### FR2 — Cluster-Wide Accuracy
Rate limit checks must be accurate and consistent regardless of which instance of the calling service — or which instance of the rate limiter itself — handles a given request. There must be no scenario where horizontal scaling silently multiplies the effective quota.

### FR3 — Low-Latency Decisions
A rate-limit check ("is this client allowed to proceed?") must resolve in a few milliseconds under normal operating conditions.

### FR4 — Fail-Safe Behavior
If the primary data store (cache/database) becomes temporarily unavailable, the system must not block all traffic. A defined degraded-mode strategy must keep the business operational, with an explicit, documented trade-off (e.g., temporary risk of minor over-quota vs. total service blockage).

The outage trade-off is a **per-client policy**, not a global constant: the default is fail-open (bounded local limiting, business traffic keeps flowing), but a client integration where quota overage carries hard financial penalties (e.g., a banking API) may be configured fail-closed (deny during outage). Both behaviors must be explicit, configurable, and visible in monitoring.

### FR5 — Usage Logging for Analytics & Billing
Every approved request must be logged with enough detail to support analytics and billing (timestamp, client ID, response time, outcome). This logging must not add latency to the core rate-limiting decision path. Denied requests are logged as well (beyond the spec's minimum) for observability and retry-pattern analysis.

"Response time" covers two distinct metrics, and the dashboard must never conflate them:
- **Decision latency** — how long the rate-limit check took; measured by the system itself on every request.
- **Upstream response time** — the third-party API's actual response time, which the rate limiter cannot observe at decision moment; callers report it after the fact via an optional reporting endpoint, and coverage of this metric is labeled on the dashboard.

### FR6 — Real-Time & Historical Dashboard
Clients must be able to view:
- Real-time current usage against their quota
- Historical trend graphs for the last 10, 15, or 30 days (configurable window)
- Filterable metrics, including average response time
- Ability to identify usage spikes/patterns over time

### FR7 — Administration
Platform engineers must be able to create, update, and view rate-limit configurations per client without downtime.

---

## 4. Non-Functional Requirements

| Category | Requirement |
|---|---|
| **Availability** | The rate limiter must run as a High Availability (HA) cluster with no single point of failure in the decision path. |
| **Performance** | p99 latency for a rate-limit check must be in the low single-digit milliseconds. |
| **Scalability** | Must support horizontal scaling of both the calling services and the rate limiter itself without correctness degradation. |
| **Resilience** | Must degrade gracefully (fail-open with safeguards) rather than fail hard on dependency outages. |
| **Consistency** | Rate-limit counters must be effectively atomic across concurrent, distributed access (no race conditions allowing overage). |
| **Observability** | Health, latency, and error metrics must be exposed for monitoring/alerting. |
| **Auditability** | All approved/denied decisions must be traceable for billing disputes and analytics. |
| **Portability** | Entire system (app + dependencies) must run locally via a single Docker Compose command. |

---

## 5. Success Metrics
- **Zero** third-party `429` errors caused by uncoordinated multi-instance overuse in staging/load tests.
- Rate-limit check latency stays under the defined SLA (few ms) at target load in performance tests.
- System continues to serve traffic (fail-open, bounded) during a simulated Redis/DB outage in chaos/edge-case tests.
- Dashboard accurately reflects logged usage with no data loss under normal operation.
- 100% of approved requests are logged under normal operation and across worker restarts (verified via test assertions, including duplicate-free replay after a worker crash), without measurable impact on decision latency. The only documented loss window is a hard Redis crash (≤1s of buffered entries with AOF `everysec` — see TRD §6.2).

---

## 6. Assumptions & Constraints
- Third-party API limits are known in advance and configured manually (not auto-discovered).
- Clients are pre-identified (e.g., via an API key or client ID) when making a rate-limit check.
- The system is used internally, behind existing network/auth boundaries — this PRD does not define external-facing authentication for the dashboard beyond a reasonable basic implementation.
- The solution is delivered as a self-contained, dockerized deliverable for evaluation purposes, not a production rollout plan.

---

## 7. Out of Scope (for this iteration)
- Automatic detection/learning of third-party rate limits.
- Multi-region/global geo-distributed deployment.
- Per-endpoint (as opposed to per-client) granular limiting (documented as a future extension).
- Billing invoice generation (only the underlying usage data is in scope).

---

## 8. Resolved Questions (were open in v1.0)
- **Should denied requests also be logged?** Yes — logged alongside approved requests (FR5). The marginal cost is near zero on the async pipeline, and denial patterns are exactly what clients need to tune their retry behavior.
- **Should the dashboard support multi-tenant access control?** Yes — a simple per-client API key scopes all dashboard queries to that client; admin keys are a separate class. Kept deliberately lightweight since the system runs behind internal network boundaries (see TRD §7).
- **Acceptable staleness for "real-time" usage?** A few seconds of lag is acceptable for the dashboard's *historical/analytics* views (fed by the async pipeline). The *current usage vs. quota* figure reads the live Redis counter and is effectively real-time.

---

*See TRD.md for the corresponding technical design and implementation approach.*
