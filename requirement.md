Global Rate Limiter as a Service

Context: Our company relies on hundreds of external APIs (banking services, logistics
providers, AI models) where pricing and availability are directly tied to strict quotas. Currently,
each microservice manages its own limits internally, which leads to chaos: if we have 10
instances of a single service, each one assumes it has the entire budget to itself. This results
in frequent '429 Too Many Requests' errors and unnecessary financial penalties.
Goal: Design and implement a High Availability (HA) service that limits the number of requests
sent to various third-party APIs.
Requirements:
● Each client has different limits (e.g., Client A: 100 req/min, Client B: 5000 req/min).
● The system will run in a cluster (multiple instances). Rate limit checks must be
accurate regardless of which service instance receives the request.
● Checking whether a client is "rate-limited" must not take longer than a few
milliseconds.
● If the database or cache becomes temporarily unavailable, the system must not block
all traffic (a fail-safe strategy must be in place).
● Every approved request must be logged for analytics and billing purposes. However,
the primary task of the Rate Limiter is to remain ultra-fast.
● The system must support a dashboard where clients can view their real-time usage
with complex filters (e.g., average response time, trend graphs for the last 10, 15, or 30
days).
Output:
What is expected from the candidate as output is:
● Complete solutions in one ZIP file
● The solution can be performed in the programming language of your choice
● Architectural diagram in image format (JPG, JPEG, IMG...)
● Detailed commented code
● Unit tests (Race Condition Unit Tests, Load & Performance Tests)
● Docker configuration (Dockerfile and docker-compose.yml) ensures the entire
application, including databases and dependencies, spins up with a single command
(docker compose up --build).
● Instructions (README.md) on how to run the solution via Docker, how to trigger tests,
and how to verify edge cases.