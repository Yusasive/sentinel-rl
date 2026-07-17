/**
 * Response-time trends — two DISTINCT metrics on one ms axis (same unit, so a
 * single axis is legitimate; they are deliberately labeled apart, per the
 * "never conflate decision latency with upstream time" product rule):
 *
 *  - decision latency: measured by the limiter on every request
 *  - upstream response time: reported by callers via POST /report; may be
 *    sparse, so coverage is stated in the panel hint rather than implied
 */
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import type { TrendPoint } from '../api';

interface Props {
  points: TrendPoint[];
  bucket: 'hour' | 'day';
}

const chrome = {
  tick: { fill: 'var(--text-muted)', fontSize: 11 },
  tooltip: {
    background: 'var(--surface-1)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    fontSize: 12,
    color: 'var(--text-primary)',
  },
};

export function LatencyChart({ points, bucket }: Props): JSX.Element {
  if (points.length === 0) {
    return <div className="empty">No latency data yet.</div>;
  }

  const data = points.map((p) => ({
    label:
      bucket === 'hour'
        ? new Date(p.bucket).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' })
        : new Date(p.bucket).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    decision: p.avgDecisionLatencyMs,
    upstream: p.avgUpstreamResponseTimeMs,
  }));
  // Sparse series (few buckets) would be invisible as pure lines — show
  // point markers until density makes them clutter.
  const dot = data.length <= 48 ? { r: 3 } : false;

  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--grid)" strokeWidth={1} vertical={false} />
        <XAxis dataKey="label" tick={chrome.tick} stroke="var(--axis)" tickLine={false} />
        <YAxis
          tick={chrome.tick}
          stroke="var(--axis)"
          tickLine={false}
          width={48}
          label={{ value: 'ms', position: 'insideTopLeft', fill: 'var(--text-muted)', fontSize: 11 }}
        />
        <Tooltip contentStyle={chrome.tooltip} cursor={{ stroke: 'var(--axis)' }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Line
          type="monotone"
          dataKey="decision"
          name="Decision latency (avg)"
          stroke="var(--series-allowed)"
          strokeWidth={2}
          dot={dot}
          activeDot={{ r: 4 }}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="upstream"
          name="Upstream response time (avg, reported)"
          stroke="var(--series-upstream)"
          strokeWidth={2}
          dot={dot}
          activeDot={{ r: 4 }}
          connectNulls
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
