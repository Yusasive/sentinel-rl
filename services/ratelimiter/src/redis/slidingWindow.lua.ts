/**
 * The atomic check-and-increment — the concurrency control of the whole system.
 *
 * Redis executes a Lua script as one indivisible unit, so the classic race
 * ("two concurrent requests both read 99/100 and both get allowed") cannot
 * happen: read → estimate → increment is atomic from Redis's perspective,
 * across every rate-limiter instance in the cluster. No distributed lock is
 * needed; this script IS the lock (TRD §9).
 *
 * Design decisions baked in (TRD §4.2):
 *
 * 1. Config is read INSIDE the script. One EVALSHA = one round trip per
 *    decision. A separate config GET would double hot-path latency.
 *
 * 2. Time comes from redis.call('TIME'), not the app clock. With multiple
 *    limiter instances in containers, clock skew would make instances
 *    disagree about which window is "current", silently breaking the
 *    cross-instance accuracy guarantee. Redis is the single time source.
 *    (TIME makes the script non-deterministic; Redis 7's default
 *    effects-based replication replicates the *writes*, not the script,
 *    so replicas stay consistent.)
 *
 * 3. Window keys are derived in-script from the config prefix. They share
 *    the {clientId} hash tag with the config key, so all keys live in one
 *    slot — the property Redis Cluster would require for multi-key scripts.
 *
 * 4. Returns the full decision tuple {allowed, remaining, retryAfterMs} so
 *    the HTTP contract is satisfied by that single round trip.
 *
 * Algorithm: sliding window counter — estimated = previous*(1-elapsed) + current.
 * Exact within a fresh window (empty previous window); a weighted estimate
 * otherwise. That approximation boundary is why the race-condition test
 * resets keys before asserting exact counts (TRD §10.2).
 */
export const SLIDING_WINDOW_LUA = `
-- KEYS[1] = ratelimit:config:{clientId}   (hash: limit, windowSeconds, onOutage)
-- ARGV[1] = counter key prefix, e.g. "ratelimit:{clientId}:"
-- Returns {allowed(0|1|-1), remaining, retryAfterMs}; -1 = unknown client.

local limit  = tonumber(redis.call('HGET', KEYS[1], 'limit'))
local window = tonumber(redis.call('HGET', KEYS[1], 'windowSeconds'))
if not limit or not window then
  return {-1, 0, 0}
end

-- Redis server time: seconds + microseconds, same value for every instance.
local t = redis.call('TIME')
local now = tonumber(t[1]) + tonumber(t[2]) / 1e6

local currentWindow = math.floor(now / window)
local elapsed = (now - currentWindow * window) / window  -- 0.0 .. 1.0

local currKey = ARGV[1] .. currentWindow
local prevKey = ARGV[1] .. (currentWindow - 1)

local current  = tonumber(redis.call('GET', currKey) or '0')
local previous = tonumber(redis.call('GET', prevKey) or '0')

-- Weighted sliding-window estimate: the previous window contributes the
-- fraction of it that still overlaps the sliding window.
local estimated = previous * (1 - elapsed) + current

if estimated >= limit then
  -- Denied. Earliest useful retry: when the current fixed window rolls over
  -- and the previous window's weight starts decaying from a fresh baseline.
  local retryAfterMs = math.ceil((1 - elapsed) * window * 1000)
  if retryAfterMs < 1 then retryAfterMs = 1 end
  return {0, 0, retryAfterMs}
end

redis.call('INCR', currKey)
-- TTL = 2 windows: the key must survive one extra window to be readable as
-- "previous" by the next window's estimates, then it self-cleans.
redis.call('EXPIRE', currKey, window * 2)

local remaining = limit - estimated - 1
if remaining < 0 then remaining = 0 end
-- RESP truncates floats; floor explicitly so the reply is a clean integer.
return {1, math.floor(remaining), 0}
`;
