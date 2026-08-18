// MapCanvas renders the Robotability map.
// It uses maplibre-gl for rendering and the pmtiles package for tile IO.
// The component is client-only. Astro never renders it on the server.
// It also hosts the breakdown panel, the layer controls, and the
// deployment video sidebar.
import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import type {
  ExpressionSpecification,
  InterpolationSpecification,
  Map as MapLibreMap,
  MapGeoJSONFeature,
  MapLayerMouseEvent,
  MapMouseEvent,
  Point,
} from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import BreakdownPanel from './BreakdownPanel';
import {
  defaultScoreBreaks,
  featureBreaks,
  quantileBreaks,
  featureRampExpression,
  parseScoreBreaks,
  scoreRampExpression,
  scoreToPercent as scorePercentOnRamp,
  type DeploymentSite,
} from './constants';
import { WEIGHTS, loadFeatureRows } from './breakdownData';
import {
  DEPLOYMENTS_LAYER_ID,
  deploymentEmbedUrl,
  deploymentLayerEntry,
  refreshDeploymentPaint,
} from './DeploymentMarkers';
import LayerControls, {
  SCORE_LAYER,
  type LayerVisibility,
  type ToggleableLayer,
} from './LayerControls';
import TimePanel from './TimePanel';
import { type RegisteredLayer, type SnapshotEntry, type SnapshotFeatureStatsEntry } from './types';

// Test hooks. Playwright reads the map instance and the active style URL
// from the window object to assert the map state. The double-underscore
// names mark them as internal. They are not a public API.
declare global {
  interface Window {
    __robotabilityMap?: MapLibreMap;
    __robotabilityMapStyleUrl?: string;
    // Switches the active snapshot by manifest date. The TimePanel
    // scrubber uses the same path. Playwright uses the hook directly.
    __robotabilityLoadSnapshot?: (date: string) => void;
  }
}

// Basemap styles. Light theme uses CARTO Positron. Dark theme uses
// CARTO Dark Matter.
const LIGHT_STYLE_URL =
  'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
const DARK_STYLE_URL =
  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

// Initial view. It matches the legacy map in RobotabilityMap.jsx.
const INITIAL_CENTER: [number, number] = [-73.9712, 40.7831];
const INITIAL_ZOOM = 12;
const INITIAL_PITCH = 45;
const INITIAL_BEARING = 0;

// The segments archive stores tiles for zooms 9-14. The census archive
// stores tiles for zooms 4-14. See scripts/tiles/build_pmtiles.mjs.
// How many feature-state writes to do before yielding to the event loop.
// The full city is about 492k segments; one unbroken pass freezes pan
// and zoom for seconds.
const FEATURE_STATE_CHUNK = 20000;

const SEGMENTS_SOURCE_MINZOOM = 9;
const SEGMENTS_SOURCE_MAXZOOM = 14;
const CENSUS_SOURCE_MINZOOM = 4;
const CENSUS_SOURCE_MAXZOOM = 14;

// Cap the device pixel ratio on HiDPI screens. MapLibre renders at the
// full devicePixelRatio by default, so a 2x Retina display paints four
// times the pixels of a 1x display. With ~492k line segments on screen
// that GPU load is a large share of the frame budget. A cap of 1.5 keeps
// most of the sharpness for a big fraction of the pixels. Set this to
// window.devicePixelRatio (or remove the setPixelRatio call) to restore
// full native sharpness at the cost of frame rate.
const MAX_PIXEL_RATIO = 1.5;

// A larger tile cache keeps more decoded tiles resident, so panning back
// over already-seen ground reuses tiles instead of re-decoding them.
const MAX_TILE_CACHE_SIZE = 250;

// The layer-spec registry. Every layer the map shows is registered here.
// A style switch re-adds every entry, so no layer is lost.
const layerRegistry = new Map<string, RegisteredLayer>();

// Register the PMTiles protocol once. The guard makes this idempotent:
// a second call is a no-op. React may mount this component more than
// once, and maplibre rejects a duplicate protocol registration.
let pmtilesProtocolRegistered = false;
function ensurePmtilesProtocol(): void {
  if (pmtilesProtocolRegistered) return;
  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', (params, abortController) =>
    protocol.tile(params, abortController)
  );
  pmtilesProtocolRegistered = true;
}

function styleUrlForTheme(theme: string | null): string {
  return theme === 'dark' ? DARK_STYLE_URL : LIGHT_STYLE_URL;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Parse and validate the manifest payload. Throw a readable error when
// the payload is unusable. The caller shows the error in the banner.
function parseManifest(raw: unknown): SnapshotEntry[] {
  if (!isRecord(raw)) {
    throw new Error('The manifest is not a JSON object.');
  }
  const list = raw['snapshots'];
  if (!Array.isArray(list)) {
    throw new Error('The manifest has no snapshots array.');
  }
  const entries: SnapshotEntry[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const date = item['date'];
    const urls = item['urls'];
    if (typeof date !== 'string' || !isRecord(urls)) continue;
    const tilesUrl = urls['segments'] ?? urls['tiles'];
    if (typeof tilesUrl !== 'string') continue;
    const censusUrl = urls['census'];
    const parquetUrl = urls['parquet'] ?? urls['features'];
    // The per-feature normalization stats. The live refresh needs them.
    // Entries with missing or non-numeric bounds are dropped.
    const rawStats = item['feature_stats'];
    let featureStats: Record<string, SnapshotFeatureStatsEntry> | undefined;
    if (isRecord(rawStats)) {
      featureStats = {};
      for (const [featureName, statValue] of Object.entries(rawStats)) {
        if (
          isRecord(statValue) &&
          typeof statValue['min'] === 'number' &&
          typeof statValue['max'] === 'number' &&
          Number.isFinite(statValue['min']) &&
          Number.isFinite(statValue['max'])
        ) {
          featureStats[featureName] = { min: statValue['min'], max: statValue['max'] };
        }
      }
    }
    entries.push({
      date,
      tag: typeof item['tag'] === 'string' ? item['tag'] : undefined,
      feature_vectors:
        typeof item['feature_vectors'] === 'boolean'
          ? item['feature_vectors']
          : undefined,
      urls: {
        segments: tilesUrl,
        census: typeof censusUrl === 'string' ? censusUrl : undefined,
        parquet: typeof parquetUrl === 'string' ? parquetUrl : undefined,
      },
      feature_stats: featureStats,
      score_breaks: parseScoreBreaks(item['score_quantiles']) ?? undefined,
    });
  }
  if (entries.length === 0) {
    throw new Error('The manifest lists no usable snapshot.');
  }
  return entries;
}

// Pick the newest snapshot. ISO dates compare correctly as strings.
function latestEntry(entries: SnapshotEntry[]): SnapshotEntry {
  return entries.reduce((best, entry) =>
    entry.date > best.date ? entry : best
  );
}

// Build the line-color expression from a snapshot's colour breaks.
// Breaks come from the manifest when the snapshot ships them, so each
// colour holds a tenth of the segments; otherwise they spread evenly
// across the full score domain. See constants.scoreRampExpression.
function scoreColorExpression(breaks: readonly number[]): ExpressionSpecification {
  return scoreRampExpression('score', breaks) as ExpressionSpecification;
}

// Build the line-width expression. Width grows with zoom, like the
// legacy map. The legacy map drew lines at a fixed screen scale.
function scoreWidthExpression(): ExpressionSpecification {
  const interpolation: InterpolationSpecification = ['exponential', 1.4];
  const input: ExpressionSpecification = ['zoom'];
  return [
    'interpolate',
    interpolation,
    input,
    SEGMENTS_SOURCE_MINZOOM,
    0.6,
    12,
    1.5,
    SEGMENTS_SOURCE_MAXZOOM,
    3,
    18,
    8,
  ];
}

// Add every registered source and layer to the map. Skip entries that
// already exist. maplibre throws on a duplicate id.
function applyRegisteredLayers(map: MapLibreMap): void {
  for (const entry of layerRegistry.values()) {
    if (!map.getSource(entry.sourceId)) {
      map.addSource(entry.sourceId, entry.source);
    }
    if (!map.getLayer(entry.layer.id)) {
      map.addLayer(entry.layer);
    }
  }
}

// Maps with a pending layer flush. One flush listener per map is enough.
// The flush applies every registry entry, so extra listeners are waste.
const pendingLayerFlush = new WeakSet<MapLibreMap>();

// Listeners that run after a successful flush. The map component uses
// them to re-apply the user layer visibility: the registry specs carry
// only the default visibility.
type LayerFlushListener = (map: MapLibreMap) => void;
const layerFlushListeners = new WeakMap<MapLibreMap, Set<LayerFlushListener>>();

// Subscribe to post-flush notifications. Returns the unsubscribe
// function for the effect cleanup.
function addLayerFlushListener(map: MapLibreMap, listener: LayerFlushListener): () => void {
  let listeners = layerFlushListeners.get(map);
  if (!listeners) {
    listeners = new Set();
    layerFlushListeners.set(map, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
  };
}

// Queue a layer flush for the next styledata or idle event. The flush
// retries while the style is still loading. It waits on styledata AND
// idle: the style can finish loading between two styledata events, so a
// styledata-only wait strands the queue. applyRegisteredLayers skips
// entries that already exist, so a double flush is harmless.
function queueLayerFlush(map: MapLibreMap): void {
  if (pendingLayerFlush.has(map)) return;
  pendingLayerFlush.add(map);
  const flush = (): void => {
    if (!map.isStyleLoaded()) {
      map.once('styledata', flush);
      map.once('idle', flush);
      return;
    }
    pendingLayerFlush.delete(map);
    try {
      applyRegisteredLayers(map);
    } catch (error) {
      console.error('Failed to flush the pending layer registrations.', error);
      return;
    }
    const listeners = layerFlushListeners.get(map);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(map);
        } catch (error) {
          console.error('A layer flush listener failed.', error);
        }
      }
    }
  };
  map.once('styledata', flush);
  map.once('idle', flush);
}

// Register a layer and add it to the map when the style is ready.
// The registration is never dropped. When the style is mid-load (for
// example while a TileJSON request is in flight), the flush queue
// applies it on the next styledata or idle event.
function registerLayer(map: MapLibreMap, key: string, entry: RegisteredLayer): void {
  layerRegistry.set(key, entry);
  if (map.isStyleLoaded()) {
    applyRegisteredLayers(map);
    return;
  }
  queueLayerFlush(map);
}

// Remove one registered layer and its source from the map and registry.
// Missing layers and sources are ignored.
function unregisterLayer(map: MapLibreMap, key: string): void {
  const entry = layerRegistry.get(key);
  layerRegistry.delete(key);
  if (!entry) return;
  if (map.getLayer(entry.layer.id)) {
    map.removeLayer(entry.layer.id);
  }
  if (map.getSource(entry.sourceId)) {
    map.removeSource(entry.sourceId);
  }
}

// Run a callback once the style is loaded. Waits on both styledata and
// idle: the style can finish loading between two styledata events, so a
// styledata-only wait can strand the callback forever. Mirrors the retry
// loop in queueLayerFlush. The ran guard makes the double listener safe.
function whenStyleLoaded(map: MapLibreMap, fn: () => void): void {
  let ran = false;
  const attempt = (): void => {
    if (ran) return;
    if (!map.isStyleLoaded()) {
      map.once('styledata', attempt);
      map.once('idle', attempt);
      return;
    }
    ran = true;
    fn();
  };
  attempt();
}

// Switch the basemap style. Capture the view first. Re-add every
// registered layer after the new style loads. Restore the view last.
function switchStyle(
  map: MapLibreMap,
  nextStyleUrl: string,
  afterRestore: (map: MapLibreMap) => void
): void {
  const view = {
    center: map.getCenter(),
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing(),
  };
  window.__robotabilityMapStyleUrl = nextStyleUrl;
  map.setStyle(nextStyleUrl);
  // setStyle can take a diff path that keeps isStyleLoaded() true while
  // the style is still applied, so never restore synchronously. Wait for
  // the first styledata or idle event, then retry until the style reports
  // loaded. The restored guard keeps the double listener from running twice.
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    if (!map.isStyleLoaded()) {
      map.once('styledata', restore);
      map.once('idle', restore);
      return;
    }
    restored = true;
    try {
      applyRegisteredLayers(map);
      afterRestore(map);
    } catch (error) {
      console.error('Failed to restore map layers after a theme switch.', error);
    }
    map.jumpTo(view);
  };
  map.once('styledata', restore);
  map.once('idle', restore);
}

// The score of one segment as a percent of the ramp. With the decile
// breaks a snapshot now ships, this is the segment's percentile.
function scoreToPercent(score: number, breaks: readonly number[]): number {
  return scorePercentOnRamp(score, breaks);
}

// The clicked segment shown in the breakdown panel.
type PanelSegment = {
  readonly id: number;
  readonly score: number;
};

// The deployment site shown in the video sidebar.
type SidebarVideo = {
  readonly name: string;
  readonly site: DeploymentSite;
};

// Default layer visibility. Census starts off. The others start on.
const DEFAULT_VISIBILITY: LayerVisibility = {
  segments: true,
  census: false,
  deployments: true,
};

export default function MapCanvas() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  // The visibility ref mirrors the state. The theme-switch restore runs
  // inside the map effect and reads the ref.
  const visibilityRef = useRef<LayerVisibility>(DEFAULT_VISIBILITY);
  // The parsed manifest entries. The snapshot-switch hook reads them.
  const manifestRef = useRef<SnapshotEntry[]>([]);
  // The snapshot apply function escapes the map effect through this ref.
  // The TimePanel and the window hook call it from component scope.
  const applySnapshotRef = useRef<((entry: SnapshotEntry) => void) | null>(null);
  // The active snapshot's colour breaks. The tooltip handler is bound
  // once in the map effect and has no entry in scope, so it reads the
  // breaks here rather than closing over the snapshot that happened to
  // be active when the map was built.
  const scoreBreaksRef = useRef<readonly number[]>(defaultScoreBreaks());

  // The error message for the visible banner. null means no error.
  const [error, setError] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<LayerVisibility>(DEFAULT_VISIBILITY);
  const [activeEntry, setActiveEntry] = useState<SnapshotEntry | null>(null);
  const [panelSegment, setPanelSegment] = useState<PanelSegment | null>(null);
  const [sidebarVideo, setSidebarVideo] = useState<SidebarVideo | null>(null);
  // The manifest entries sorted by date ascending. The TimePanel maps
  // them onto the scrubber.
  const [entries, setEntries] = useState<SnapshotEntry[]>([]);
  // The map instance as state. The TimePanel mounts only after the map
  // exists, so its effects always see a live map.
  const [mapInstance, setMapInstance] = useState<MapLibreMap | null>(null);
  // What the segments layer draws: SCORE_LAYER or one feature name.
  const [colorBy, setColorBy] = useState<string>(SCORE_LAYER);
  const [featureLoading, setFeatureLoading] = useState(false);
  // How many segments currently carry feature state. Diagnostic only;
  // the clear is a single bulk call.
  const featureStateCountRef = useRef<number>(0);
  // The active colour source, for the tooltip. Bound once, like the
  // breaks ref above.
  const colorByRef = useRef<string>(SCORE_LAYER);

  // Switch the active snapshot by manifest date. The TimePanel scrubber
  // and the window hook share this path.
  const loadSnapshotByDate = useCallback((date: string): void => {
    const entry = manifestRef.current.find((candidate) => candidate.date === date);
    if (!entry) {
      console.warn(`No snapshot with date ${date} exists in the manifest.`);
      return;
    }
    applySnapshotRef.current?.(entry);
  }, []);

  const getMapInstance = useCallback((): MapLibreMap | null => {
    return mapRef.current;
  }, []);

  // Repaint the segments layer whenever the colour source or the
  // snapshot changes.
  //
  // The score comes from the tiles, so switching back to it is just a
  // paint-property change. A feature does not: the tiles carry only id
  // and score, so its values are read from features.parquet and pushed
  // into feature state, one entry per segment. That table is the same
  // one the breakdown panel loads and it is cached after the first read.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !activeEntry) return;
    let cancelled = false;

    // One call clears the whole source layer. Removing 491k ids one at a
    // time is slow enough to be visible, and nothing else on this source
    // owns feature state.
    const clearFeatureState = (): void => {
      if (!map.getSource('segments-source')) return;
      map.removeFeatureState({ source: 'segments-source', sourceLayer: 'segments' });
      featureStateCountRef.current = 0;
    };

    const paint = (expression: unknown): void => {
      if (!map.getLayer('segments')) return;
      map.setPaintProperty('segments', 'line-color', expression as never);
    };

    colorByRef.current = colorBy;

    if (colorBy === SCORE_LAYER) {
      clearFeatureState();
      paint(scoreColorExpression(activeEntry.score_breaks ?? defaultScoreBreaks()));
      setFeatureLoading(false);
      return;
    }

    const parquetUrl = activeEntry.urls.parquet ?? activeEntry.urls.features ?? null;
    if (parquetUrl === null) return;

    setFeatureLoading(true);
    void (async (): Promise<void> => {
      try {
        const rows = await loadFeatureRows(parquetUrl, activeEntry.tag ?? activeEntry.date);
        if (cancelled) return;
        clearFeatureState();
        // Colour breaks come from this feature's own distribution, not
        // from the [0, 1] domain. Every feature is min-max normalized,
        // so the domain is always full, but the shape is not: a linear
        // ramp put 81.7% of slope_gradient and 96.3% of
        // intersection_safety in the first colour. Deciles give every
        // colour an equal share of segments. A column with no finite
        // value falls back to the linear ramp.
        const values: number[] = [];
        for (const row of rows) {
          const v = row[colorBy];
          if (typeof v === 'number' && Number.isFinite(v)) values.push(v);
        }
        // Paint first so tiles already on screen pick up state as it
        // arrives, rather than staying on the score ramp until the last
        // row lands.
        // Seven features carry polarity -1, where a high value is the
        // harmful one. The ramp flips for those so red keeps meaning
        // worse for a robot on every layer.
        const polarity = WEIGHTS.find((w) => w.feature === colorBy)?.polarity ?? 1;
        paint(featureRampExpression(quantileBreaks(values) ?? featureBreaks(), polarity));
        // Write in chunks with a yield between them. Half a million
        // setFeatureState calls in one pass blocks the main thread long
        // enough to freeze panning and zooming.
        let written = 0;
        for (let i = 0; i < rows.length; i += FEATURE_STATE_CHUNK) {
          if (cancelled) return;
          const end = Math.min(i + FEATURE_STATE_CHUNK, rows.length);
          for (let j = i; j < end; j += 1) {
            const row = rows[j];
            const id = row['segment_id'];
            const value = row[colorBy];
            if (typeof id !== 'number' || typeof value !== 'number' || !Number.isFinite(value)) {
              continue;
            }
            map.setFeatureState(
              { source: 'segments-source', sourceLayer: 'segments', id },
              { featureValue: value },
            );
            written += 1;
          }
          if (end < rows.length) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
        if (cancelled) return;
        featureStateCountRef.current = written;
        if (written === 0) {
          setError(`The snapshot carries no values for ${colorBy}.`);
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        console.error('Feature layer load failed.', err);
        setError(`The feature layer could not load: ${message}`);
        setColorBy(SCORE_LAYER);
      } finally {
        if (!cancelled) setFeatureLoading(false);
      }
    })();

    return (): void => {
      cancelled = true;
    };
  }, [colorBy, activeEntry]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;

    ensurePmtilesProtocol();

    const initialTheme = document.documentElement.getAttribute('data-theme');
    const initialStyleUrl = styleUrlForTheme(initialTheme);

    const map = new maplibregl.Map({
      container,
      style: initialStyleUrl,
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
      pitch: INITIAL_PITCH,
      bearing: INITIAL_BEARING,
      renderWorldCopies: false,
      maxTileCacheSize: MAX_TILE_CACHE_SIZE,
    });
    map.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    mapRef.current = map;
    setMapInstance(map);

    // Expose the map for the Playwright spec. See the declare-global
    // comment at the top of this file.
    window.__robotabilityMap = map;
    window.__robotabilityMapStyleUrl = initialStyleUrl;

    // The tooltip is a plain DOM node, like the legacy map.
    const tooltip = document.createElement('div');
    tooltip.style.display = 'none';
    tooltip.style.position = 'absolute';
    tooltip.style.pointerEvents = 'none';
    tooltip.style.zIndex = '100';
    tooltip.style.backgroundColor = 'white';
    tooltip.style.color = '#282728';
    tooltip.style.padding = '8px 12px';
    tooltip.style.borderRadius = '6px';
    tooltip.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
    tooltip.style.fontSize = '14px';
    container.appendChild(tooltip);

    const positionTooltip = (point: Point, text: string): void => {
      tooltip.textContent = text;
      tooltip.style.display = 'block';
      tooltip.style.left = `${point.x}px`;
      tooltip.style.top = `${point.y}px`;
      tooltip.style.transform = 'translate(-50%, -100%) translateY(-10px)';
    };

    const hideTooltip = (): void => {
      tooltip.style.display = 'none';
    };

    const showSegmentTooltip = (point: Point, feature: MapGeoJSONFeature): void => {
      const score: unknown = feature.properties['score'];
      if (typeof score !== 'number') {
        hideTooltip();
        return;
      }
      const id: unknown = feature.properties['id'];
      const label = typeof id === 'number' ? String(id) : 'unknown';
      // On a feature layer report that feature's value, which is what the
      // colour shows. Reporting the score there would describe a
      // different quantity from the one under the cursor.
      const active = colorByRef.current;
      if (active !== SCORE_LAYER) {
        const stateValue = (feature.state as Record<string, unknown> | undefined)?.[
          'featureValue'
        ];
        const shown =
          typeof stateValue === 'number' ? stateValue.toFixed(4) : 'no value';
        positionTooltip(point, `${active}: ${shown} | Segment ${label}`);
        return;
      }
      positionTooltip(
        point,
        `Score: ${scoreToPercent(score, scoreBreaksRef.current).toFixed(1)}% | Segment ${label}`,
      );
    };

    const showDeploymentTooltip = (point: Point, feature: MapGeoJSONFeature): void => {
      const name: unknown = feature.properties['name'];
      if (typeof name !== 'string') {
        hideTooltip();
        return;
      }
      positionTooltip(point, name);
    };

    // Apply one snapshot entry to the map. It replaces the segments
    // source and adds or removes the census source. It also resets the
    // layer visibility and closes the panel.
    const applySnapshot = (entry: SnapshotEntry): void => {
      const run = (): void => {
        try {
          unregisterLayer(map, 'segments');
          unregisterLayer(map, 'census');

          const tilesUrl = entry.urls.segments;
          if (!tilesUrl) {
            if (!disposed) setError(`The snapshot ${entry.date} has no tiles URL.`);
            return;
          }
          const breaks = entry.score_breaks ?? defaultScoreBreaks();
          scoreBreaksRef.current = breaks;
          registerLayer(map, 'segments', {
            sourceId: 'segments-source',
            source: {
              type: 'vector',
              url: `pmtiles://${tilesUrl}`,
              minzoom: SEGMENTS_SOURCE_MINZOOM,
              maxzoom: SEGMENTS_SOURCE_MAXZOOM,
              attribution: `Robotability snapshot ${entry.date}`,
              // Promote the id attribute to the feature id so
              // setFeatureState can address a segment. The feature layers
              // carry their values in feature state, keyed by this id,
              // because the tiles hold only id and score.
              promoteId: 'id',
            },
            layer: {
              id: 'segments',
              type: 'line',
              source: 'segments-source',
              'source-layer': 'segments',
              paint: {
                'line-color': scoreColorExpression(breaks),
                'line-width': scoreWidthExpression(),
                'line-opacity': 0.9,
              },
            },
          });
          if (entry.urls.census) {
            registerLayer(map, 'census', {
              sourceId: 'census-source',
              source: {
                type: 'vector',
                url: `pmtiles://${entry.urls.census}`,
                minzoom: CENSUS_SOURCE_MINZOOM,
                maxzoom: CENSUS_SOURCE_MAXZOOM,
              },
              layer: {
                id: 'census',
                type: 'line',
                source: 'census-source',
                'source-layer': 'census',
                // Off by default. The layer controls toggle it on.
                layout: { visibility: 'none' },
                paint: {
                  'line-color': 'rgba(100, 100, 100, 0.4)',
                  'line-width': 1,
                },
              },
            });
          }

          // Reset visibility to the defaults. The registry specs carry
          // the same defaults.
          visibilityRef.current = DEFAULT_VISIBILITY;
          if (!disposed) {
            setVisibility(DEFAULT_VISIBILITY);
            setActiveEntry(entry);
            setPanelSegment(null);
          }
        } catch (err) {
          console.error('Map layer registration failed.', err);
          if (!disposed) setError('The map layers could not be added.');
        }
      };
      whenStyleLoaded(map, run);
    };

    // Load the manifest and apply the newest snapshot.
    const loadManifest = async (): Promise<void> => {
      let entries: SnapshotEntry[];
      try {
        const response = await fetch('/manifest.json');
        if (!response.ok) {
          throw new Error(`The manifest request failed with status ${response.status}.`);
        }
        const raw: unknown = await response.json();
        entries = parseManifest(raw);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('Map manifest load failed.', err);
        if (!disposed) setError(message);
        return;
      }
      if (disposed) return;
      manifestRef.current = entries;
      // The scrubber maps the entries sorted by date ascending.
      setEntries(
        [...entries].sort((left, right) =>
          left.date < right.date ? -1 : left.date > right.date ? 1 : 0,
        ),
      );
      applySnapshot(latestEntry(entries));
    };

    // Expose the snapshot apply function to the component scope. The
    // TimePanel scrubber and the window hook share the same path.
    applySnapshotRef.current = applySnapshot;
    window.__robotabilityLoadSnapshot = loadSnapshotByDate;

    // Open the video sidebar and fly to the clicked deployment marker.
    const handleDeploymentClick = (event: MapLayerMouseEvent): void => {
      const feature = event.features?.[0];
      if (!feature) return;
      const name: unknown = feature.properties['name'];
      const videoId: unknown = feature.properties['videoId'];
      const startTime: unknown = feature.properties['startTime'];
      const endTime: unknown = feature.properties['endTime'];
      if (
        typeof name !== 'string' ||
        typeof videoId !== 'string' ||
        typeof startTime !== 'number' ||
        typeof endTime !== 'number'
      ) {
        return;
      }
      if (feature.geometry.type !== 'Point') return;
      const [lon, lat] = feature.geometry.coordinates;
      if (disposed) return;
      setSidebarVideo({
        name,
        site: { coords: [lat, lon], videoId, startTime, endTime },
      });
      map.flyTo({
        center: [lon, lat],
        zoom: 16,
        pitch: 60,
        duration: 2000,
      });
    };

    // Open the breakdown panel for the clicked segment. Ignore clicks
    // that also hit a deployment marker.
    const handleSegmentClick = (event: MapLayerMouseEvent): void => {
      if (map.getLayer(DEPLOYMENTS_LAYER_ID)) {
        const markers = map.queryRenderedFeatures(event.point, {
          layers: [DEPLOYMENTS_LAYER_ID],
        });
        if (markers.length > 0) return;
      }
      const feature = event.features?.[0];
      if (!feature) return;
      const id: unknown = feature.properties['id'];
      const score: unknown = feature.properties['score'];
      if (typeof id !== 'number' || typeof score !== 'number') return;
      if (disposed) return;
      setPanelSegment({ id, score });
    };

    map.on('load', () => {
      // The markers register through the layer registry, so a theme
      // switch re-adds them.
      registerLayer(map, 'deployments', deploymentLayerEntry());
      void loadManifest();
    });

    // Consolidated hover handling for the tooltip and the pointer cursor.
    //
    // MapLibre implements every layer-specific mousemove, mouseenter and
    // mouseleave listener as a delegate that runs queryRenderedFeatures on
    // every raw mousemove event. The previous code registered eight such
    // listeners, four per layer, so a single mousemove ran eight point
    // queries against ~492k line features. While panning, mousemove fires
    // continuously, and those queries blocked the main thread and froze the
    // map. One map-level handler replaces all eight. It coalesces to
    // animation frames, runs a single query across both layers, and skips
    // all work while the camera moves, so a pan never runs a feature query.
    let hoverFrame: number | null = null;
    let hoverX = 0;
    let hoverY = 0;

    const clearHover = (): void => {
      hideTooltip();
      map.getCanvas().style.cursor = '';
    };

    const runHoverQuery = (): void => {
      hoverFrame = null;
      // No feature queries while the camera moves. Pan, zoom and rotate all
      // fire mousemove continuously; querying then is what froze the map.
      // The tooltip reappears on the next mouse move once the camera settles.
      if (map.isMoving() || map.isZooming() || map.isRotating()) {
        clearHover();
        return;
      }
      const layers: string[] = [];
      if (map.getLayer(DEPLOYMENTS_LAYER_ID)) layers.push(DEPLOYMENTS_LAYER_ID);
      if (map.getLayer('segments')) layers.push('segments');
      if (layers.length === 0) {
        clearHover();
        return;
      }
      const point = new maplibregl.Point(hoverX, hoverY);
      const features = map.queryRenderedFeatures(point, { layers });
      if (features.length === 0) {
        clearHover();
        return;
      }
      map.getCanvas().style.cursor = 'pointer';
      // A deployment marker wins over a segment beneath it. The old code
      // got this by registering the deployment listener last.
      const deployment = features.find((f) => f.layer.id === DEPLOYMENTS_LAYER_ID);
      if (deployment) {
        showDeploymentTooltip(point, deployment);
        return;
      }
      const segment = features.find((f) => f.layer.id === 'segments');
      if (segment) {
        showSegmentTooltip(point, segment);
      }
    };

    const handleHover = (event: MapMouseEvent): void => {
      hoverX = event.point.x;
      hoverY = event.point.y;
      if (hoverFrame === null) {
        hoverFrame = requestAnimationFrame(runHoverQuery);
      }
    };

    map.on('mousemove', handleHover);
    map.on('mouseout', () => {
      if (hoverFrame !== null) {
        cancelAnimationFrame(hoverFrame);
        hoverFrame = null;
      }
      clearHover();
    });

    map.on('click', 'segments', handleSegmentClick);
    map.on('click', 'deployments', handleDeploymentClick);

    // Re-apply the user visibility and the marker accent after a theme
    // switch. The registry specs carry only the default visibility.
    const afterThemeRestore = (restoredMap: MapLibreMap): void => {
      const current = visibilityRef.current;
      for (const layerKey of Object.keys(current) as ToggleableLayer[]) {
        if (restoredMap.getLayer(layerKey)) {
          restoredMap.setLayoutProperty(
            layerKey,
            'visibility',
            current[layerKey] ? 'visible' : 'none'
          );
        }
      }
      refreshDeploymentPaint(restoredMap);
    };

    // Watch the data-theme attribute on the html element. The theme
    // script and any future toggle write this attribute.
    const observer = new MutationObserver(() => {
      const theme = document.documentElement.getAttribute('data-theme');
      const nextStyleUrl = styleUrlForTheme(theme);
      if (nextStyleUrl === window.__robotabilityMapStyleUrl) return;
      switchStyle(map, nextStyleUrl, afterThemeRestore);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    // A flush adds layers with the registry default visibility. The
    // listener re-applies the user visibility, exactly like the theme
    // switch restore does.
    const unsubscribeFlush = addLayerFlushListener(map, afterThemeRestore);

    return () => {
      disposed = true;
      if (hoverFrame !== null) {
        cancelAnimationFrame(hoverFrame);
        hoverFrame = null;
      }
      observer.disconnect();
      unsubscribeFlush();
      applySnapshotRef.current = null;
      if (window.__robotabilityMap === map) {
        delete window.__robotabilityMap;
      }
      delete window.__robotabilityMapStyleUrl;
      delete window.__robotabilityLoadSnapshot;
      tooltip.remove();
      mapRef.current = null;
      map.remove();
    };
  }, []);

  // Toggle one layer's visibility through setLayoutProperty.
  const handleToggle = useCallback((layerKey: ToggleableLayer): void => {
    const nextValue = !visibilityRef.current[layerKey];
    const next = { ...visibilityRef.current, [layerKey]: nextValue };
    visibilityRef.current = next;
    setVisibility(next);
    const map = mapRef.current;
    if (map && map.getLayer(layerKey)) {
      map.setLayoutProperty(layerKey, 'visibility', nextValue ? 'visible' : 'none');
    }
  }, []);

  const closeSidebar = useCallback((): void => {
    setSidebarVideo(null);
  }, []);

  const closePanel = useCallback((): void => {
    setPanelSegment(null);
  }, []);

  return (
    <div className="relative h-screen w-full">
      {error !== null && (
        <div
          role="alert"
          data-testid="map-error-banner"
          style={{
            position: 'absolute',
            top: '1rem',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 200,
            maxWidth: '40rem',
            padding: '0.75rem 1rem',
            backgroundColor: '#a50026',
            color: 'white',
            borderRadius: '6px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
          }}
        >
          The map could not load. {error}
        </div>
      )}
      {/* The maplibre container needs an explicit height. The maplibre
          CSS forces position:relative on this element, so absolute
          positioning classes collapse it to zero height. */}
      <div
        ref={containerRef}
        data-testid="map-container"
        style={{ position: 'relative', width: '100%', height: '100%' }}
      />

      <LayerControls
        visibility={visibility}
        censusAvailable={Boolean(activeEntry?.urls.census)}
        onToggle={handleToggle}
        colorBy={colorBy}
        onColorByChange={setColorBy}
        featureLoading={featureLoading}
        featureDisabledReason={
          activeEntry === null
            ? 'No snapshot loaded.'
            : (activeEntry.urls.parquet ?? activeEntry.urls.features ?? null) === null
              ? 'This snapshot ships no feature table, so only the score can be drawn.'
              : null
        }
      />

      {mapInstance !== null && (
        <TimePanel
          entries={entries}
          activeEntry={activeEntry}
          onLoadSnapshot={loadSnapshotByDate}
          getMap={getMapInstance}
        />
      )}

      {panelSegment !== null && activeEntry !== null && (
        <BreakdownPanel
          entry={activeEntry}
          segmentId={panelSegment.id}
          tileScore={panelSegment.score}
          onClose={closePanel}
        />
      )}

      {sidebarVideo !== null && (
        <div
          data-testid="deployment-sidebar"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            height: '100%',
            width: '24rem',
            maxWidth: '90vw',
            zIndex: 160,
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: 'rgb(var(--color-fill))',
            color: 'rgb(var(--color-text-base))',
            borderRight: '1px solid rgb(var(--color-border))',
            boxShadow: '2px 0 8px rgba(0,0,0,0.15)',
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
            <strong>{sidebarVideo.name}</strong>
            <button
              type="button"
              data-testid="deployment-sidebar-close"
              onClick={closeSidebar}
              aria-label="Close video sidebar"
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
          <div style={{ flex: 1, padding: '0.75rem 1rem' }}>
            <div style={{ position: 'relative', width: '100%', paddingTop: '56.25%' }}>
              <iframe
                data-testid="deployment-video"
                src={deploymentEmbedUrl(sidebarVideo.site)}
                title={`Deployment video: ${sidebarVideo.name}`}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  border: 'none',
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
