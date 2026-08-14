// BreakdownPanel shows why one segment got its score.
// It lists all 19 features with normalized value, weight, polarity, and
// signed contribution. The bottom row shows the segment score total.
// Snapshots without feature vectors show one fixed fallback sentence.
import { useCallback, useEffect, useState } from 'react';
import {
  buildBreakdown,
  findRow,
  loadFeatureRows,
  type Breakdown,
  type FeatureRow,
} from './breakdownData';
import { FALLBACK_SENTENCE, type SnapshotEntry } from './types';

type BreakdownPanelProps = {
  readonly entry: SnapshotEntry;
  readonly segmentId: number;
  readonly tileScore: number;
  readonly onClose: () => void;
};

// The panel data state machine. idle: loading. fallback: no feature
// vectors in this snapshot. ready: rows parsed. error: fetch or parse
// failed. The error state offers a retry button.
type PanelState =
  | { kind: 'idle' }
  | { kind: 'fallback' }
  | { kind: 'ready'; breakdown: Breakdown; row: FeatureRow }
  | { kind: 'error'; message: string };

// Resolve the parquet URL from a manifest entry. The key appears as
// "parquet" in new manifests and as "features" in older ones.
function parquetUrlFor(entry: SnapshotEntry): string | null {
  return entry.urls.parquet ?? entry.urls.features ?? null;
}

export default function BreakdownPanel(props: BreakdownPanelProps) {
  const { entry, segmentId, tileScore, onClose } = props;
  // The initial state knows the fallback case up front. This avoids a
  // one-frame flash of the loading text for snapshots without vectors.
  const [state, setState] = useState<PanelState>(() =>
    entry.feature_vectors !== true ? { kind: 'fallback' } : { kind: 'idle' }
  );
  // The retry token changes on every retry click. The load effect runs
  // again when it changes.
  const [retryToken, setRetryToken] = useState(0);

  const retry = useCallback(() => {
    setRetryToken((token) => token + 1);
  }, []);

  useEffect(() => {
    // Snapshot #0 has no feature vectors. Show the fixed sentence.
    if (entry.feature_vectors !== true) {
      setState({ kind: 'fallback' });
      return;
    }
    const parquetUrl = parquetUrlFor(entry);
    if (parquetUrl === null) {
      setState({
        kind: 'error',
        message: 'The manifest lists no feature table for this snapshot.',
      });
      return;
    }
    let cancelled = false;
    setState({ kind: 'idle' });
    const tag = entry.tag ?? entry.date;
    loadFeatureRows(parquetUrl, tag)
      .then((rows) => {
        if (cancelled) return;
        const row = findRow(rows, segmentId);
        if (row === null) {
          setState({
            kind: 'error',
            message: 'The feature table has no row for this segment.',
          });
          return;
        }
        setState({ kind: 'ready', breakdown: buildBreakdown(row), row });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        console.error('Breakdown panel failed to load the feature table.', err);
        setState({ kind: 'error', message });
      });
    return () => {
      cancelled = true;
    };
  }, [entry, segmentId, retryToken]);

  return (
    <aside
      data-testid="breakdown-panel"
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        height: '100%',
        width: '22rem',
        maxWidth: '90vw',
        zIndex: 150,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'rgb(var(--color-fill))',
        color: 'rgb(var(--color-text-base))',
        borderLeft: '1px solid rgb(var(--color-border))',
        boxShadow: '-2px 0 8px rgba(0,0,0,0.15)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0.75rem 1rem',
          borderBottom: '1px solid rgb(var(--color-border))',
        }}
      >
        <strong>Segment {segmentId}</strong>
        <button
          type="button"
          data-testid="breakdown-close"
          onClick={onClose}
          aria-label="Close breakdown panel"
          style={{
            border: 'none',
            background: 'transparent',
            color: 'inherit',
            font: 'inherit',
            fontSize: '1.25rem',
            lineHeight: 1,
            cursor: 'pointer',
          }}
        >
          ×
        </button>
      </div>

      <div
        data-testid="breakdown-body"
        style={{ flex: 1, overflowY: 'auto', padding: '0.75rem 1rem' }}
      >
        {state.kind === 'idle' && <p>Loading feature data…</p>}

        {state.kind === 'fallback' && <p>{FALLBACK_SENTENCE}</p>}

        {state.kind === 'error' && (
          <div data-testid="breakdown-retry">
            <p>The feature table did not load. {state.message}</p>
            <button
              type="button"
              data-testid="breakdown-retry-button"
              onClick={retry}
              style={{
                padding: '0.4rem 0.9rem',
                border: '1px solid rgb(var(--color-border))',
                backgroundColor: 'rgb(var(--color-card))',
                color: 'inherit',
                cursor: 'pointer',
              }}
            >
              Retry
            </button>
          </div>
        )}

        {state.kind === 'ready' && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid rgb(var(--color-border))' }}>
                <th style={{ padding: '0.25rem 0' }}>Feature</th>
                <th style={{ padding: '0.25rem 0' }}>Value</th>
                <th style={{ padding: '0.25rem 0' }}>Weight</th>
                <th style={{ padding: '0.25rem 0' }}>±</th>
                <th style={{ padding: '0.25rem 0', textAlign: 'right' }}>Contribution</th>
              </tr>
            </thead>
            <tbody>
              {state.breakdown.entries.map((item) => (
                <tr
                  key={item.feature}
                  data-testid="breakdown-row"
                  style={{ borderBottom: '1px solid rgb(var(--color-border))' }}
                >
                  <td style={{ padding: '0.3rem 0.25rem 0.3rem 0' }}>
                    {item.displayName}
                    <div
                      style={{
                        height: '4px',
                        marginTop: '2px',
                        backgroundColor: 'rgb(var(--color-card-muted))',
                      }}
                    >
                      <div
                        data-testid="breakdown-bar"
                        style={{
                          height: '100%',
                          width: `${Math.min(1, Math.max(0, item.normalized)) * 100}%`,
                          backgroundColor: 'rgb(var(--color-accent))',
                        }}
                      />
                    </div>
                  </td>
                  <td style={{ padding: '0.3rem 0.25rem' }}>{item.normalized.toFixed(2)}</td>
                  <td style={{ padding: '0.3rem 0.25rem' }}>{item.weight.toFixed(4)}</td>
                  <td style={{ padding: '0.3rem 0.25rem' }}>
                    {item.polarity >= 0 ? '+' : '-'}
                  </td>
                  <td
                    style={{
                      padding: '0.3rem 0',
                      textAlign: 'right',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {item.contribution >= 0 ? '+' : ''}
                    {item.contribution.toFixed(4)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {state.kind === 'ready' && (
        <div
          style={{
            padding: '0.75rem 1rem',
            borderTop: '1px solid rgb(var(--color-border))',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
            <span>Score total</span>
            <span data-testid="breakdown-total" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {state.breakdown.total.toFixed(4)}
            </span>
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: '0.8rem',
              opacity: 0.8,
              marginTop: '0.25rem',
            }}
          >
            <span>Tile score</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{tileScore.toFixed(4)}</span>
          </div>
        </div>
      )}
    </aside>
  );
}
