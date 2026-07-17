/**
 * Request volume over time: allowed vs denied.
 *
 * Two series → legend present + line-end direct labels; identity is never
 * color-alone. Allowed wears categorical slot 1 (blue); denied is a *state*,
 * so it wears the reserved critical status color (validated pair, ΔE ≥ 23).
 * Single y-axis (both series are counts).
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

function formatBucket(iso: string, bucket: 'hour' | 'day'): string {
  const date = new Date(iso);
  return bucket === 'hour'
    ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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

export function TrendChart({ points, bucket }: Props): JSX.Element {
  if (points.length === 0) {
    return <div className="empty">No traffic logged yet — send some /check requests.</div>;
  }

  const data = points.map((p) => ({ ...p, label: formatBucket(p.bucket, bucket) }));
  // Sparse series (few buckets) would be invisible as pure lines — show
  // point markers until density makes them clutter.
  const dot = data.length <= 48 ? { r: 3 } : false;

  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--grid)" strokeWidth={1} vertical={false} />
        <XAxis dataKey="label" tick={chrome.tick} stroke="var(--axis)" tickLine={false} />
        <YAxis tick={chrome.tick} stroke="var(--axis)" tickLine={false} allowDecimals={false} width={48} />
        <Tooltip contentStyle={chrome.tooltip} cursor={{ stroke: 'var(--axis)' }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Line
          type="monotone"
          dataKey="allowed"
          name="Allowed"
          stroke="var(--series-allowed)"
          strokeWidth={2}
          dot={dot}
          activeDot={{ r: 4 }}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="denied"
          name="Denied"
          stroke="var(--series-denied)"
          strokeWidth={2}
          dot={dot}
          activeDot={{ r: 4 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
