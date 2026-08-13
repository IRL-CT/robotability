// TimePanel adds the time UI to the map: a snapshot scrubber, a play
// button, an A/B diff mode, and the opt-in live refresh.
//
// Design decisions (documented per the T10 spec):
// - The scrubber maps every manifest entry onto one range stop, sorted
//   by date. Scrubbing switches the snapshot through the same
//   loadSnapshot path the map already uses.
// - Play advances one snapshot per 700 ms and stops at the last entry.
//   The loop stays off.
// - Diff mode loads snapshot B as the tile layer and joins BOTH
//   snapshots' parquet tables on segment_id (T9 loader: hyparquet plus
//   Cache API). maplibre cannot color one vector source by values from
//   another source, so the deltas paint through a generated GeoJSON
//   overlay built from the rendered B geometries. The overlay rebuilds
//   on moveend while diff mode is active. This is the simplest robust
//   implementation: no feature-state wiring, no tile re-encoding.
// - Live refresh is opt-in. It runs only on the button click. No
//   moveend or zoomend handler ever triggers a refresh.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ExpressionSpecification,
  GeoJSONSource,
  InterpolationSpecification,
  LayerSpecification,
  Map as MapLibreMap,
} from 'maplibre-gl';
import { loadFeatureRows } from './breakdownData';
import { SCORE_COLORS, SCORE_DOMAIN_MAX, SCORE_DOMAIN_MIN } from './constants';
import type { SnapshotEntry } from './types';
import { SodaClient } from '../../lib/soda/client';
import { createQuotaGuard } from '../../lib/soda/quotaGuard';
import type { TimeWindowPreset } from '../../lib/soda/timeWindows';
import {
  bboxAreaKm2,
  LIVE_AREA_CAP_KM2,
  runLiveRefresh,
  toFeatureStats,
  type LiveSegmentResult,
  type SegmentAnchor,
} from '../../lib/live/refresh';

// Test hooks. Playwright reads the time, diff, and live state from the
// window object. The double-underscore names mark them as internal.
export type TimeHookState = {
  readonly dates: string[];
  readonly activeDate: string | null;
  readonly playing: boolean;
};

export type DiffHookState = {
  readonly active: boolean;
  readonly dateA: string | null;
  readonly dateB: string | null;
  readonly deltas: ReadonlyArray<{ readonly id: number; readonly delta: number }>;
  readonly minDelta: number | null;
  readonly maxDelta: number | null;
};

export type LiveHookState = {
  readonly active: boolean;
  readonly results: readonly LiveSegmentResult[];
};

declare global {
  interface Window {
    __robotabilityTimeState?: TimeHookState;
    __robotabilityDiffState?: DiffHookState;
    __robotabilityLiveState?: LiveHookState;
  }
}

// One snapshot step per 700 ms. The plan fixes the rate.
const PLAY_STEP_MS = 700;

// Exact UI sentences. The e2e spec asserts them byte for byte. Do not
// edit one without the same edit in e2e/time-live.spec.ts.
const ZOOM_SENTENCE = 'Zoom in to refresh a smaller area.';
const DISABLED_SENTENCE = 'Live refresh is unavailable. Showing the latest snapshot.';
const STATS_SENTENCE = 'Live refresh needs a snapshot with feature statistics.';
const DIFF_PARQUET_SENTENCE = 'Diff needs two snapshots with feature tables.';

// Overlay source and layer ids. The diff and live overlays are separate
// so one never repaints the other.
const DIFF_SOURCE_ID = 'diff-source';
const DIFF_LAYER_ID = 'diff-overlay';
const LIVE_SOURCE_ID = 'live-source';
const LIVE_LAYER_ID = 'live-overlay';

// The diverging diff ramp: blue at the lowest delta, white in the
// middle, red at the highest delta. The range is the delta range
// present in the joined data.
function divergingRamp(minDelta: number, maxDelta: number): ExpressionSpecification {
  const lo = Math.min(minDelta, maxDelta);
  const hi = Math.max(minDelta, maxDelta);
  const mid = (lo + hi) / 2;
  // A degenerate range (every delta equal) still needs rising stops.
  const eps = hi - lo < 1e-9 ? 0.0005 : 0;
  return [
    'interpolate',
    ['linear'],
    ['get', 'delta'],
    lo - eps,
    'rgb(33, 102, 172)',
    mid,
    'rgb(255, 255, 255)',
    hi + eps,
    'rgb(178, 24, 43)',
  ];
}

// The score ramp for the live overlay. The stops match the segments
// layer in MapCanvas.tsx (scoreColorExpression). The copy keeps the
// TimePanel free of a MapCanvas import, which would be circular.
function liveScoreRamp(): ExpressionSpecification {
  const stops: Array<number | string> = [];
  const span = SCORE_DOMAIN_MAX - SCORE_DOMAIN_MIN;
  const lastIndex = SCORE_COLORS.length - 1;
  for (let i = 0; i < SCORE_COLORS.length; i += 1) {
    stops.push(SCORE_DOMAIN_MIN + (span * i) / lastIndex);
    const color = SCORE_COLORS[i];
    stops.push(`rgb(${color[0]}, ${color[1]}, ${color[2]})`);
  }
  const interpolation: InterpolationSpecification = ['linear'];
  return ['interpolate', interpolation, ['get', 'liveScore'], ...stops];
}

// The overlay line width. It tracks the segments width with a small
// bump so the overlay covers the snapshot line beneath it.
function overlayWidthExpression(): ExpressionSpecification {
  const interpolation: InterpolationSpecification = ['exponential', 1.4];
  return [
    '+',
    ['interpolate', interpolation, ['zoom'], 9, 0.6, 12, 1.5, 14, 3, 18, 8],
    0.75,
  ];
}

// Run fn once the style is loaded. Retry on styledata while it loads.
function whenStyleReady(map: MapLibreMap, fn: () => void): void {
  const run = (): void => {
    if (!map.isStyleLoaded()) {
      map.once('styledata', run);
      return;
    }
    try {
      fn();
    } catch (error) {
      console.error('TimePanel overlay update failed.', error);
    }
  };
  run();
}

// Remove one overlay layer and source. Missing ids are ignored.
function removeOverlay(map: MapLibreMap, layerId: string, sourceId: string): void {
  if (map.getLayer(layerId)) {
    map.removeLayer(layerId);
  }
  if (map.getSource(sourceId)) {
    map.removeSource(sourceId);
  }
}

// One rendered segment: its geometry and its tile score.
type RenderedSegment = {
  readonly geometry: GeoJSON.Geometry;
  readonly score: number;
};

// Collect the rendered segments of the viewport, deduplicated by id.
function collectRenderedSegments(map: MapLibreMap): Map<number, RenderedSegment> {
  const segments = new Map<number, RenderedSegment>();
  if (!map.getLayer('segments')) return segments;
  const features = map.queryRenderedFeatures({ layers: ['segments'] });
  for (const feature of features) {
    const id: unknown = feature.properties['id'];
    const score: unknown = feature.properties['score'];
    if (typeof id !== 'number' || typeof score !== 'number') continue;
    if (segments.has(id)) continue;
    segments.set(id, { geometry: feature.geometry, score });
  }
  return segments;
}

// Build a GeoJSON feature collection from the rendered segments. The
// props callback returns the feature properties, or null to skip the
// segment.
function buildOverlayCollection(
  rendered: Map<number, RenderedSegment>,
  propsFor: (id: number, segment: RenderedSegment) => Record<string, number> | null,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const [id, segment] of rendered) {
    const properties = propsFor(id, segment);
    if (properties === null) continue;
    features.push({ type: 'Feature', properties, geometry: segment.geometry });
  }
  return { type: 'FeatureCollection', features };
}

type TimePanelProps = {
  // All manifest entries, sorted by date ascending.
  readonly entries: readonly SnapshotEntry[];
  readonly activeEntry: SnapshotEntry | null;
  // The same loadSnapshot path the map uses for every snapshot switch.
  readonly onLoadSnapshot: (date: string) => void;
  readonly getMap: () => MapLibreMap | null;
};

export default function TimePanel(props: TimePanelProps) {
  const { entries, activeEntry, onLoadSnapshot, getMap } = props;

  const dates = useMemo(() => entries.map((entry) => entry.date), [entries]);
  const activeDate = activeEntry?.date ?? null;
  const activeIndex = activeDate === null ? -1 : dates.indexOf(activeDate);

  const [playing, setPlaying] = useState(false);
  const [diffMode, setDiffMode] = useState(false);
  const [dateA, setDateA] = useState('');
  const [dateB, setDateB] = useState('');
  const [diffMessage, setDiffMessage] = useState<string | null>(null);
  const [diffDeltas, setDiffDeltas] = useState<
    ReadonlyArray<{ readonly id: number; readonly delta: number }>
  >([]);
  const [diffRange, setDiffRange] = useState<{ min: number; max: number } | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveResults, setLiveResults] = useState<readonly LiveSegmentResult[] | null>(null);
  const [preset, setPreset] = useState<TimeWindowPreset>('all');

  // Overlay data refs. The styledata and moveend handlers rebuild the
  // overlays from these refs after any style or view change.
  const diffByIdRef = useRef<Map<number, number> | null>(null);
  const diffRangeRef = useRef<{ min: number; max: number } | null>(null);
  const liveByIdRef = useRef<Map<
    number,
    { liveScore: number; delta: number; snapshotScore: number }
  > | null>(null);
  const datesRef = useRef(dates);
  const activeDateRef = useRef(activeDate);

  useEffect(() => {
    datesRef.current = dates;
    activeDateRef.current = activeDate;
  }, [dates, activeDate]);

  // ----- window hooks for the e2e spec -----

  useEffect(() => {
    window.__robotabilityTimeState = { dates, activeDate, playing };
  }, [dates, activeDate, playing]);

  useEffect(() => {
    window.__robotabilityDiffState = {
      active: diffMode && diffRange !== null,
      dateA: diffMode ? dateA : null,
      dateB: diffMode ? dateB : null,
      deltas: diffDeltas,
      minDelta: diffRange?.min ?? null,
      maxDelta: diffRange?.max ?? null,
    };
  }, [diffMode, dateA, dateB, diffDeltas, diffRange]);

  useEffect(() => {
    window.__robotabilityLiveState =
      liveResults === null ? { active: false, results: [] } : { active: true, results: liveResults };
  }, [liveResults]);

  useEffect(() => {
    return () => {
      delete window.__robotabilityTimeState;
      delete window.__robotabilityDiffState;
      delete window.__robotabilityLiveState;
    };
  }, []);

  // ----- overlay painting -----

  // Rebuild the diff overlay from the current viewport geometries.
  const paintDiffOverlay = useCallback((): void => {
    const map = getMap();
    if (!map) return;
    const deltas = diffByIdRef.current;
    const range = diffRangeRef.current;
    if (!deltas || !range) return;
    whenStyleReady(map, () => {
      const rendered = collectRenderedSegments(map);
      const collection = buildOverlayCollection(rendered, (id) => {
        const delta = deltas.get(id);
        return delta === undefined ? null : { id, delta };
      });
      removeOverlay(map, DIFF_LAYER_ID, DIFF_SOURCE_ID);
      map.addSource(DIFF_SOURCE_ID, { type: 'geojson', data: collection });
      map.addLayer({
        id: DIFF_LAYER_ID,
        type: 'line',
        source: DIFF_SOURCE_ID,
        paint: {
          'line-color': divergingRamp(range.min, range.max),
          'line-width': overlayWidthExpression(),
          'line-opacity': 0.95,
        },
      });
    });
  }, [getMap]);

  // Rebuild the live overlay from the current viewport geometries.
  const paintLiveOverlay = useCallback((): void => {
    const map = getMap();
    if (!map) return;
    const live = liveByIdRef.current;
    if (!live) return;
    whenStyleReady(map, () => {
      const rendered = collectRenderedSegments(map);
      const collection = buildOverlayCollection(rendered, (id) => {
        const entry = live.get(id);
        if (!entry) return null;
        return {
          id,
          liveScore: entry.liveScore,
          delta: entry.delta,
          snapshotScore: entry.snapshotScore,
        };
      });
      removeOverlay(map, LIVE_LAYER_ID, LIVE_SOURCE_ID);
      map.addSource(LIVE_SOURCE_ID, { type: 'geojson', data: collection });
      map.addLayer({
        id: LIVE_LAYER_ID,
        type: 'line',
        source: LIVE_SOURCE_ID,
        paint: {
          'line-color': liveScoreRamp(),
          'line-width': overlayWidthExpression(),
          'line-opacity': 0.95,
        },
      });
    });
  }, [getMap]);

  // Drop both overlays from the map and the refs.
  const clearOverlays = useCallback((): void => {
    diffByIdRef.current = null;
    diffRangeRef.current = null;
    liveByIdRef.current = null;
    setDiffDeltas([]);
    setDiffRange(null);
    setDiffMessage(null);
    setLiveResults(null);
    setBanner(null);
    const map = getMap();
    if (!map) return;
    whenStyleReady(map, () => {
      removeOverlay(map, DIFF_LAYER_ID, DIFF_SOURCE_ID);
      removeOverlay(map, LIVE_LAYER_ID, LIVE_SOURCE_ID);
    });
  }, [getMap]);

  // Repaint surviving overlays after style changes (theme switch,
  // snapshot switch) and after the view moves. The diff overlay covers
  // the new viewport too. The live overlay keeps its click-time
  // segments: a pan never triggers a new live query.
  useEffect(() => {
    const map = getMap();
    if (!map) return;
    const onStyleChange = (): void => {
      if (diffByIdRef.current && diffRangeRef.current) paintDiffOverlay();
      if (liveByIdRef.current) paintLiveOverlay();
    };
    const onMoveEnd = (): void => {
      if (diffByIdRef.current && diffRangeRef.current) paintDiffOverlay();
    };
    map.on('styledata', onStyleChange);
    map.on('moveend', onMoveEnd);
    return () => {
      map.off('styledata', onStyleChange);
      map.off('moveend', onMoveEnd);
    };
  }, [getMap, paintDiffOverlay, paintLiveOverlay]);

  // ----- snapshot switching -----

  // Switch the snapshot. Scrubber and play switches clear the overlays.
  // The diff computation calls onLoadSnapshot directly so its own base
  // layer switch keeps the overlay.
  const switchSnapshot = useCallback(
    (date: string): void => {
      clearOverlays();
      setDiffMode(false);
      onLoadSnapshot(date);
    },
    [clearOverlays, onLoadSnapshot],
  );

  const handleScrub = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      const index = Number.parseInt(event.target.value, 10);
      const entry = entries[index];
      if (!entry) return;
      if (entry.date === activeDate) return;
      switchSnapshot(entry.date);
    },
    [entries, activeDate, switchSnapshot],
  );

  // ----- play -----

  const handlePlayToggle = useCallback((): void => {
    if (playing) {
      setPlaying(false);
      return;
    }
    // Play starts only before the last entry. The loop stays off.
    const index = datesRef.current.indexOf(activeDateRef.current ?? '');
    if (index < 0 || index >= datesRef.current.length - 1) return;
    setPlaying(true);
  }, [playing]);

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      const list = datesRef.current;
      const index = list.indexOf(activeDateRef.current ?? '');
      if (index < 0 || index >= list.length - 1) {
        setPlaying(false);
        return;
      }
      const next = list[index + 1];
      if (next !== undefined) {
        switchSnapshot(next);
      }
    }, PLAY_STEP_MS);
    return () => clearInterval(timer);
  }, [playing, switchSnapshot]);

  // ----- diff mode -----

  const handleDiffToggle = useCallback((): void => {
    if (diffMode) {
      setDiffMode(false);
      clearOverlays();
      return;
    }
    clearOverlays();
    setDiffMode(true);
    setDateA(dates[0] ?? '');
    setDateB(dates[dates.length - 1] ?? '');
  }, [diffMode, clearOverlays, dates]);

  // Compute the diff for the selected dates. The join runs on the two
  // parquet tables. Snapshot B becomes the visible tile layer.
  useEffect(() => {
    if (!diffMode) return;
    const entryA = entries.find((entry) => entry.date === dateA);
    const entryB = entries.find((entry) => entry.date === dateB);
    if (!entryA || !entryB) return;
    const urlA = entryA.urls.parquet ?? entryA.urls.features ?? null;
    const urlB = entryB.urls.parquet ?? entryB.urls.features ?? null;
    if (urlA === null || urlB === null) {
      setDiffMessage(DIFF_PARQUET_SENTENCE);
      setDiffDeltas([]);
      setDiffRange(null);
      diffByIdRef.current = null;
      diffRangeRef.current = null;
      return;
    }
    let cancelled = false;
    setDiffMessage(null);
    void (async (): Promise<void> => {
      try {
        const [rowsA, rowsB] = await Promise.all([
          loadFeatureRows(urlA, entryA.tag ?? entryA.date),
          loadFeatureRows(urlB, entryB.tag ?? entryB.date),
        ]);
        if (cancelled) return;
        const scoreA = new Map<number, number>();
        for (const row of rowsA) {
          const id = row['segment_id'];
          const score = row['score'];
          if (typeof id === 'number' && typeof score === 'number') {
            scoreA.set(id, score);
          }
        }
        const deltas: Array<{ id: number; delta: number }> = [];
        for (const row of rowsB) {
          const id = row['segment_id'];
          const score = row['score'];
          if (typeof id !== 'number' || typeof score !== 'number') continue;
          const base = scoreA.get(id);
          if (base === undefined) continue;
          deltas.push({ id, delta: score - base });
        }
        let min = 0;
        let max = 0;
        for (const item of deltas) {
          if (item.delta < min) min = item.delta;
          if (item.delta > max) max = item.delta;
        }
        diffByIdRef.current = new Map(deltas.map((item) => [item.id, item.delta]));
        diffRangeRef.current = { min, max };
        setDiffDeltas(deltas);
        setDiffRange({ min, max });
        // Show snapshot B as the base tiles, then paint the deltas.
        if (activeDateRef.current !== entryB.date) {
          onLoadSnapshot(entryB.date);
        }
        paintDiffOverlay();
      } catch (error) {
        console.error('Diff mode failed to load the feature tables.', error);
        if (!cancelled) {
          setDiffMessage('The diff data did not load.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [diffMode, dateA, dateB, entries, onLoadSnapshot, paintDiffOverlay]);

  // ----- live refresh -----

  // The click handler. Opt-in only: no other code path runs a refresh.
  const handleLiveRefresh = useCallback(async (): Promise<void> => {
    const map = getMap();
    if (!map || !activeEntry) return;
    setBanner(null);

    // The active snapshot must carry feature stats. The engine
    // normalizes the live raw values with them.
    const stats = toFeatureStats(activeEntry.feature_stats);
    if (stats === null) {
      setBanner(STATS_SENTENCE);
      return;
    }

    // The area cap protects the shared quota. A large viewport sends
    // zero requests.
    const bounds = map.getBounds();
    const area = bboxAreaKm2({
      minLon: bounds.getWest(),
      minLat: bounds.getSouth(),
      maxLon: bounds.getEast(),
      maxLat: bounds.getNorth(),
    });
    if (area > LIVE_AREA_CAP_KM2) {
      setBanner(ZOOM_SENTENCE);
      return;
    }

    // The viewport segments become the query anchors.
    const rendered = collectRenderedSegments(map);
    const anchors: SegmentAnchor[] = [];
    for (const [id, segment] of rendered) {
      if (segment.geometry.type !== 'LineString') continue;
      const coords = segment.geometry.coordinates;
      if (coords.length === 0) continue;
      const mid = coords[Math.floor(coords.length / 2)];
      anchors.push({ id, midpoint: { lon: mid[0], lat: mid[1] }, snapshotScore: segment.score });
    }
    if (anchors.length === 0) {
      setBanner('No segments are visible in this view.');
      return;
    }

    setLiveLoading(true);
    try {
      // A closure around window.fetch keeps the correct receiver. A
      // detached fetch reference throws "Illegal invocation" in the
      // browser. The SODA client and the GBFS feed share this wrapper.
      const boundFetch = (input: string, init?: RequestInit): Promise<Response> =>
        fetch(input, init);
      // The non-live features come from the snapshot parquet rows.
      const parquetUrl = activeEntry.urls.parquet ?? activeEntry.urls.features ?? null;
      let parquetRows: Awaited<ReturnType<typeof loadFeatureRows>> | null = null;
      if (parquetUrl !== null) {
        try {
          parquetRows = await loadFeatureRows(parquetUrl, activeEntry.tag ?? activeEntry.date);
        } catch (error) {
          console.warn('Live refresh could not load the snapshot feature table.', error);
          parquetRows = null;
        }
      }
      const outcome = await runLiveRefresh({
        client: new SodaClient({ fetchImpl: boundFetch }),
        guard: createQuotaGuard(),
        stats,
        segments: anchors,
        window: preset,
        fetchImpl: boundFetch,
        parquetRows,
      });
      if (outcome.status === 'disabled') {
        setBanner(DISABLED_SENTENCE);
        return;
      }
      if (outcome.status === 'error') {
        setBanner(`Live refresh failed. ${outcome.message}`);
        return;
      }
      const byId = new Map<
        number,
        { liveScore: number; delta: number; snapshotScore: number }
      >();
      for (const result of outcome.results) {
        if (result.status === 'scored') {
          byId.set(result.id, {
            liveScore: result.liveScore,
            delta: result.delta,
            snapshotScore: result.snapshotScore,
          });
        }
      }
      liveByIdRef.current = byId;
      setLiveResults(outcome.results);
      paintLiveOverlay();
    } finally {
      setLiveLoading(false);
    }
  }, [getMap, activeEntry, preset, paintLiveOverlay]);

  // The live delta list shows the biggest movers first.
  const liveDeltaRows = useMemo(() => {
    if (liveResults === null) return [];
    const scored = liveResults.filter(
      (entry): entry is Extract<LiveSegmentResult, { status: 'scored' }> =>
        entry.status === 'scored',
    );
    scored.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    return scored.slice(0, 8);
  }, [liveResults]);

  // The panel docks at the top center. The pointer-events passthrough
  // on the wrapper keeps the map clickable around the rows: only the
  // rows themselves catch events. The top position keeps the bottom of
  // the viewport free for map interaction.
  const panelStyle: React.CSSProperties = {
    position: 'absolute',
    top: '1rem',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 140,
    padding: '0.75rem 1rem',
    backgroundColor: 'rgb(var(--color-fill))',
    color: 'rgb(var(--color-text-base))',
    border: '1px solid rgb(var(--color-border))',
    boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
    fontSize: '0.85rem',
    maxWidth: 'min(42rem, 92vw)',
    pointerEvents: 'none',
  };

  // One row catches pointer events as a whole, so the controls inside it
  // stay easy to hit.
  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '0.6rem',
    pointerEvents: 'auto',
  };

  return (
    <div data-testid="time-panel" style={panelStyle}>
      {/* Row 1: play button, scrubber, active date. */}
      <div style={rowStyle}>
        <button
          type="button"
          data-testid="play-button"
          onClick={handlePlayToggle}
          disabled={diffMode}
          aria-label={playing ? 'Pause snapshot playback' : 'Play snapshot playback'}
          style={{
            padding: '0.3rem 0.7rem',
            border: '1px solid rgb(var(--color-border))',
            backgroundColor: 'rgb(var(--color-card))',
            color: 'inherit',
            cursor: diffMode ? 'default' : 'pointer',
            opacity: diffMode ? 0.5 : 1,
          }}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <input
          type="range"
          data-testid="time-scrubber"
          min={0}
          max={Math.max(0, entries.length - 1)}
          step={1}
          value={activeIndex < 0 ? 0 : activeIndex}
          onChange={handleScrub}
          disabled={diffMode}
          aria-label="Snapshot time scrubber"
          style={{ flex: 1, minWidth: '10rem' }}
        />
        <span data-testid="active-date" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {activeDate ?? '—'}
        </span>
      </div>

      {/* Row 2: diff mode controls and legend. */}
      <div style={{ ...rowStyle, marginTop: '0.5rem' }}>
        <button
          type="button"
          data-testid="diff-toggle"
          onClick={handleDiffToggle}
          style={{
            padding: '0.3rem 0.7rem',
            border: '1px solid rgb(var(--color-border))',
            backgroundColor: diffMode ? 'rgb(var(--color-accent))' : 'rgb(var(--color-card))',
            color: diffMode ? 'white' : 'inherit',
            cursor: 'pointer',
          }}
        >
          {diffMode ? 'Exit diff' : 'Diff mode'}
        </button>
        {diffMode && (
          <>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
              A
              <select
                data-testid="diff-a"
                value={dateA}
                onChange={(event) => setDateA(event.target.value)}
                aria-label="Diff date A"
              >
                {dates.map((date) => (
                  <option key={date} value={date}>
                    {date}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
              B
              <select
                data-testid="diff-b"
                value={dateB}
                onChange={(event) => setDateB(event.target.value)}
                aria-label="Diff date B"
              >
                {dates.map((date) => (
                  <option key={date} value={date}>
                    {date}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {diffMode && diffMessage !== null && (
          <span data-testid="diff-message">{diffMessage}</span>
        )}
        {diffMode && diffRange !== null && (
          <span data-testid="diff-legend" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
            <span
              style={{
                display: 'inline-block',
                width: '6rem',
                height: '0.7rem',
                border: '1px solid rgb(var(--color-border))',
                background:
                  'linear-gradient(to right, rgb(33, 102, 172), rgb(255, 255, 255), rgb(178, 24, 43))',
              }}
            />
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
              {diffRange.min.toFixed(3)} … {diffRange.max.toFixed(3)}
            </span>
          </span>
        )}
      </div>

      {/* Row 3: live refresh controls, badge, banner, delta list. */}
      <div style={{ ...rowStyle, marginTop: '0.5rem' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
          Window
          <select
            data-testid="live-window"
            value={preset}
            onChange={(event) => setPreset(event.target.value as TimeWindowPreset)}
            aria-label="Live refresh time window"
          >
            <option value="30d">30d</option>
            <option value="90d">90d</option>
            <option value="1y">1y</option>
            <option value="all">all</option>
          </select>
        </label>
        <button
          type="button"
          data-testid="live-refresh-button"
          onClick={() => void handleLiveRefresh()}
          disabled={diffMode || liveLoading}
          style={{
            padding: '0.3rem 0.7rem',
            border: '1px solid rgb(var(--color-border))',
            backgroundColor: 'rgb(var(--color-card))',
            color: 'inherit',
            cursor: diffMode || liveLoading ? 'default' : 'pointer',
            opacity: diffMode || liveLoading ? 0.5 : 1,
          }}
        >
          {liveLoading ? 'Refreshing…' : 'Refresh live'}
        </button>
        {liveResults !== null && (
          <span
            data-testid="live-badge"
            style={{
              padding: '0.15rem 0.5rem',
              backgroundColor: 'rgb(var(--color-accent))',
              color: 'white',
              fontWeight: 700,
            }}
          >
            LIVE · approximate
          </span>
        )}
      </div>

      {banner !== null && (
        <div
          data-testid="live-banner"
          role="status"
          style={{ marginTop: '0.5rem', pointerEvents: 'auto' }}
        >
          {banner}
        </div>
      )}

      {liveDeltaRows.length > 0 && (
        <div
          data-testid="live-delta-list"
          style={{
            marginTop: '0.5rem',
            maxHeight: '8rem',
            overflowY: 'auto',
            pointerEvents: 'auto',
          }}
        >
          {liveDeltaRows.map((entry) => (
            <div
              key={entry.id}
              data-testid="live-delta-row"
              style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem' }}
            >
              <span>Segment {entry.id}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                {entry.liveScore.toFixed(3)} {entry.delta >= 0 ? '▲' : '▼'}{' '}
                {Math.abs(entry.delta).toFixed(3)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
