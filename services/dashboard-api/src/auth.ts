/**
 * Dashboard tenancy (TRD §7): X-API-Key resolves to an identity; every usage
 * query is scoped so Client A cannot read Client B's usage or spend. Admin
 * keys may access any client and mutate configuration.
 *
 * Deliberately lightweight (keys in Postgres, checked per request) — the
 * system runs behind internal network boundaries per the PRD.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';

export interface Identity {
  clientId: string;
  isAdmin: boolean;
}

export async function resolveIdentity(pool: Pool, apiKey: string): Promise<Identity | null> {
  const result = await pool.query<{ client_id: string; is_admin: boolean }>(
    'SELECT client_id, is_admin FROM client_configs WHERE api_key = $1',
    [apiKey],
  );
  const row = result.rows[0];
  return row ? { clientId: row.client_id, isAdmin: row.is_admin } : null;
}

/**
 * PreHandler factory: authenticates the key and (optionally) authorizes
 * access to the :clientId in the route. Attaches identity to the request.
 */
export function requireAuth(pool: Pool) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const apiKey = request.headers['x-api-key'];
    if (typeof apiKey !== 'string' || apiKey.length === 0) {
      await reply.status(401).send({ error: 'missing_api_key' });
      return;
    }

    const identity = await resolveIdentity(pool, apiKey);
    if (!identity) {
      await reply.status(401).send({ error: 'invalid_api_key' });
      return;
    }

    // Tenancy check: non-admin keys may only touch their own clientId.
    const params = request.params as { clientId?: string };
    if (params.clientId && !identity.isAdmin && params.clientId !== identity.clientId) {
      await reply.status(403).send({ error: 'forbidden', message: 'Key is scoped to another client' });
      return;
    }

    (request as FastifyRequest & { identity: Identity }).identity = identity;
  };
}

export function getIdentity(request: FastifyRequest): Identity {
  return (request as FastifyRequest & { identity: Identity }).identity;
}
