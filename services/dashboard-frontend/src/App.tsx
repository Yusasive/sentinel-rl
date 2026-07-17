/**
 * Usage dashboard (FR6):
 *  - real-time usage vs quota (polls the live Redis-backed endpoint every 2s)
 *  - historical trends over 10/15/30 days with hour/day bucketing
 *  - decision latency vs reported upstream response time
 *
 * Auth: an API key scopes everything server-side. A client key sees only its
 * own client; the admin key can switch between clients.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type ClientSummary, type CurrentUsage, type TrendResponse } from './api';
import { StatTiles } from './components/StatTiles';
import { TrendChart } from './components/TrendChart';
import { LatencyChart } from './components/LatencyChart';

const DAY_OPTIONS = [10, 15, 30] as const;

export function App(): JSX.Element {
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem('apiKey') ?? '');
  const [keyInput, setKeyInput] = useState(apiKey);
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [clientId, setClientId] = useState<string>('');
  const [days, setDays] = useState<(typeof DAY_OPTIONS)[number]>(10);
  const [bucket, setBucket] = useState<'hour' | 'day'>('hour');
  const [usage, setUsage] = useState<CurrentUsage | null>(null);
  const [trend, setTrend] = useState<TrendResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback((key: string) => {
    localStorage.setItem('apiKey', key);
    setApiKey(key);
    setError(null);
  }, []);

  // Load the client list for this key (one entry for client keys; all for admin).
  useEffect(() => {
    if (!apiKey) return;
    api
      .clients(apiKey)
      .then((list) => {
        setClients(list);
        setClientId((current) => current || list[0]?.clientId || '');
        setError(null);
      })
      .catch((err: unknown) => {
        setClients([]);
        setUsage(null);
        setTrend(null);
        setError(err instanceof ApiError && err.status === 401 ? 'Invalid API key' : 'API unreachable');
      });
  }, [apiKey]);

  // Real-time usage: poll every 2 seconds while a client is selected.
  useEffect(() => {
    if (!apiKey || !clientId) return;
    let cancelled = false;
    const load = (): void => {
      api
        .currentUsage(apiKey, clientId)
        .then((data) => {
          if (!cancelled) setUsage(data);
        })
        .catch(() => undefined); // transient poll failures: keep last value
    };
    load();
    const timer = setInterval(load, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [apiKey, clientId]);

  // Historical trend: reload when the window/bucket/client changes.
  useEffect(() => {
    if (!apiKey || !clientId) return;
    let cancelled = false;
    api
      .trend(apiKey, clientId, days, bucket)
      .then((data) => {
        if (!cancelled) setTrend(data);
      })
      .catch(() => undefined);
    const timer = setInterval(() => {
      api
        .trend(apiKey, clientId, days, bucket)
        .then((data) => {
          if (!cancelled) setTrend(data);
        })
        .catch(() => undefined);
    }, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [apiKey, clientId, days, bucket]);

  const reportedTotal = trend?.points.reduce((sum, p) => sum + p.reportedCount, 0) ?? 0;
  const decisionsTotal = trend?.points.reduce((sum, p) => sum + p.allowed + p.denied, 0) ?? 0;

  return (
    <div className="shell">
      <header className="top">
        <h1>Rate Limiter — Usage Dashboard</h1>
        <div className="controls">
          <input
            type="password"
            placeholder="API key (e.g. key-client-a)"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && connect(keyInput)}
            aria-label="API key"
          />
          <button onClick={() => connect(keyInput)}>Connect</button>
        </div>
      </header>

      {error && <p className="error">{error}</p>}
      {!apiKey && !error && (
        <p className="status-line">
          Enter an API key to view usage. Seeded demo keys: <code>key-client-a</code>,{' '}
          <code>key-client-b</code>, <code>key-bank-strict</code>, admin: <code>key-admin</code>.
        </p>
      )}

      {clients.length > 0 && (
        <>
          <div className="controls" style={{ marginBottom: 16 }}>
            <select
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              aria-label="Client"
              disabled={clients.length === 1}
            >
              {clients.map((c) => (
                <option key={c.clientId} value={c.clientId}>
                  {c.name} ({c.clientId})
                </option>
              ))}
            </select>
            {DAY_OPTIONS.map((option) => (
              <button
                key={option}
                className={days === option ? 'active' : ''}
                onClick={() => setDays(option)}
              >
                {option}d
              </button>
            ))}
            <select
              value={bucket}
              onChange={(e) => setBucket(e.target.value as 'hour' | 'day')}
              aria-label="Bucket size"
            >
              <option value="hour">hourly buckets</option>
              <option value="day">daily buckets</option>
            </select>
          </div>

          {usage && <StatTiles usage={usage} />}

          <section className="panel">
            <h2>Requests — allowed vs denied</h2>
            <p className="hint">
              Last {days} days, {bucket}ly buckets. Fed by the async log pipeline (a few seconds
              behind real time).
            </p>
            <TrendChart points={trend?.points ?? []} bucket={bucket} />
          </section>

          <section className="panel">
            <h2>Response time</h2>
            <p className="hint">
              Decision latency is measured on every request. Upstream response time exists only
              where callers reported it via POST /report — coverage here:{' '}
              {decisionsTotal > 0 ? `${reportedTotal.toLocaleString()} of ${decisionsTotal.toLocaleString()} requests` : 'no data yet'}
              .
            </p>
            <LatencyChart points={trend?.points ?? []} bucket={bucket} />
          </section>
        </>
      )}
    </div>
  );
}
