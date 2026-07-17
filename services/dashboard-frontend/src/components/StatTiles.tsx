/**
 * Headline numbers — stat tiles, not charts: single values whose job is
 * magnitude-at-a-glance. The usage meter is the only graphic; it flips to the
 * critical status color above 90% utilization (with the % label carrying the
 * value, never color alone).
 */
import type { CurrentUsage } from '../api';

interface Props {
  usage: CurrentUsage;
}

/** Open padlock: traffic keeps flowing during an outage (fail-open). */
function OpenLockIcon(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ verticalAlign: '-3px', marginRight: 6 }}>
      <rect x="3" y="11" width="14" height="10" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 9.9-1" />
    </svg>
  );
}

/** Closed padlock: requests denied during an outage (fail-closed). */
function ClosedLockIcon(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ verticalAlign: '-3px', marginRight: 6 }}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

export function StatTiles({ usage }: Props): JSX.Element {
  const pct = Math.round(usage.utilization * 100);
  const hot = usage.utilization >= 0.9;

  return (
    <div className="tiles">
      <div className="tile">
        <div className="label">Current window usage</div>
        <div className="value">
          {usage.used.toLocaleString()}
          <span style={{ fontSize: 15, color: 'var(--text-muted)' }}>
            {' '}/ {usage.limit.toLocaleString()}
          </span>
        </div>
        <div className="meter" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className={hot ? 'hot' : ''} style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
        <div className="sub">{pct}% of quota this {usage.windowSeconds}s window</div>
      </div>

      <div className="tile">
        <div className="label">Remaining</div>
        <div className="value">{usage.remaining.toLocaleString()}</div>
        <div className="sub">requests left in window</div>
      </div>

      <div className="tile">
        <div className="label">Configured limit</div>
        <div className="value">{usage.limit.toLocaleString()}</div>
        <div className="sub">per {usage.windowSeconds}s window</div>
      </div>

      <div className="tile">
        <div className="label">Outage policy</div>
        <div className="value" style={{ fontSize: 20 }}>
          {usage.onOutage === 'open' ? (
            <><OpenLockIcon />Fail-open</>
          ) : (
            <><ClosedLockIcon />Fail-closed</>
          )}
        </div>
        <div className="sub">
          {usage.onOutage === 'open'
            ? 'bounded local fallback during Redis outage'
            : 'requests denied during Redis outage'}
        </div>
      </div>
    </div>
  );
}
