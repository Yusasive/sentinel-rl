/**
 * Typed client for the dashboard API. All requests carry X-API-Key; the API
 * scopes every query to the key's client (admin keys may select any client).
 */

export interface CurrentUsage {
  clientId: string;
  limit: number;
  windowSeconds: number;
  used: number;
  remaining: number;
  utilization: number;
  onOutage: 'open' | 'closed';
}

export interface TrendPoint {
  bucket: string;
  allowed: number;
  denied: number;
  avgDecisionLatencyMs: number | null;
  avgUpstreamResponseTimeMs: number | null;
  reportedCount: number;
}

export interface TrendResponse {
  clientId: string;
  days: number;
  bucket: 'hour' | 'day';
  points: TrendPoint[];
}

export interface ClientSummary {
  clientId: string;
  name: string;
  limitPerWindow: number;
  windowSeconds: number;
  onOutage: 'open' | 'closed';
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function get<T>(path: string, apiKey: string): Promise<T> {
  const response = await fetch(`/api${path}`, {
    headers: { 'X-API-Key': apiKey },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(response.status, body.error ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export const api = {
  clients: (apiKey: string) => get<ClientSummary[]>('/clients', apiKey),
  currentUsage: (apiKey: string, clientId: string) =>
    get<CurrentUsage>(`/usage/${encodeURIComponent(clientId)}/current`, apiKey),
  trend: (apiKey: string, clientId: string, days: number, bucket: 'hour' | 'day') =>
    get<TrendResponse>(
      `/usage/${encodeURIComponent(clientId)}/trend?days=${days}&bucket=${bucket}`,
      apiKey,
    ),
};
