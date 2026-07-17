/**
 * Redis key helpers — MUST mirror services/ratelimiter/src/redis/client.ts.
 * The {clientId} braces are the hash tag that co-locates all of one client's
 * keys in a single slot (Redis Cluster compatibility, TRD §4.1).
 */
export const configKey = (clientId: string): string => `ratelimit:config:{${clientId}}`;
export const counterKeyPrefix = (clientId: string): string => `ratelimit:{${clientId}}:`;
