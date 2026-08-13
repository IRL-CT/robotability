// MapCanvas renders the Robotability map.
// It uses maplibre-gl for rendering and the pmtiles package for tile IO.
// The component is client-only. Astro never renders it on the server.
import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import type {
  ExpressionSpecification,
  InterpolationSpecification,
  LayerSpecification,
  Map as MapLibreMap,
  MapLayerMouseEvent,
  SourceSpecification,
} from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import { SCORE_COLORS, SCORE_DOMAIN_MAX, SCORE_DOMAIN_MIN } from './constants';

// Test hooks. Playwright reads the map instance and the active style URL
// from the window object to assert the map state. The double-underscore
// names mark them as internal. They are not a public API.
declare global {
  interface Window {
    __robotabilityMap?: MapLibreMap;
    __robotabilityMapStyleUrl?: string;
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
const SEGMENTS_SOURCE_MINZOOM = 9;
const SEGMENTS_SOURCE_MAXZOOM = 14;
const CENSUS_SOURCE_MINZOOM = 4;
const CENSUS_SOURCE_MAXZOOM = 14;

// One entry in the layer-spec registry.
// The source spec and the layer spec travel together. A style switch
// removes every source and layer from the map. The restore step re-adds
// every registry entry, so no layer is lost.
export type RegisteredLayer = {
  readonly sourceId: string;
  readonly source: SourceSpecification;
  readonly layer: LayerSpecification;
};

// The layer-spec registry. Every layer the map shows is registered here.
// Later tasks add their layers through this registry too, so a style
// switch re-adds them as well.
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

// Shape of one snapshot entry in public/manifest.json.
// The tiles URL appears under "segments" in new manifests and under
// "tiles" in the T4 baseline manifest. The parser accepts both keys.
type SnapshotUrls = {
  readonly segments?: string;
  readonly census?: string;
};

type SnapshotEntry = {
  readonly date: string;
  readonly tag?: string;
  readonly feature_vectors?: boolean;
  readonly urls: SnapshotUrls;
};

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
      },
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

// Build the line-color expression. The 11 ramp colors divide the full
// score domain into 10 equal parts. Stop 0 sits at the domain minimum.
// The last stop sits at the domain maximum.
function scoreColorExpression(): ExpressionSpecification {
  const stops: Array<number | string> = [];
  const span = SCORE_DOMAIN_MAX - SCORE_DOMAIN_MIN;
  const lastIndex = SCORE_COLORS.length - 1;
  for (let i = 0; i < SCORE_COLORS.length; i += 1) {
    stops.push(SCORE_DOMAIN_MIN + (span * i) / lastIndex);
    const color = SCORE_COLORS[i];
    stops.push(`rgb(${color[0]}, ${color[1]}, ${color[2]})`);
  }
  const interpolation: InterpolationSpecification = ['linear'];
  const input: ExpressionSpecification = ['get', 'score'];
  return ['interpolate', interpolation, input, ...stops];
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

// Register a layer and add it to the map when the style is ready.
function registerLayer(map: MapLibreMap, key: string, entry: RegisteredLayer): void {
  layerRegistry.set(key, entry);
  if (map.isStyleLoaded()) {
    applyRegisteredLayers(map);
  }
}

// Switch the basemap style. Capture the view first. Re-add every
// registered layer after the new style loads. Restore the view last.
function switchStyle(map: MapLibreMap, nextStyleUrl: string): void {
  const view = {
    center: map.getCenter(),
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing(),
  };
  window.__robotabilityMapStyleUrl = nextStyleUrl;
  map.setStyle(nextStyleUrl);
  const restore = (): void => {
    if (!map.isStyleLoaded()) {
      map.once('styledata', restore);
      return;
    }
    try {
      applyRegisteredLayers(map);
    } catch (error) {
      console.error('Failed to restore map layers after a theme switch.', error);
    }
    map.jumpTo(view);
  };
  map.once('styledata', restore);
}

// The score of one segment as a percent of the full domain.
function scoreToPercent(score: number): number {
  return ((score - SCORE_DOMAIN_MIN) / (SCORE_DOMAIN_MAX - SCORE_DOMAIN_MIN)) * 100;
}

export default function MapCanvas() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // The error message for the visible banner. null means no error.
  const [error, setError] = useState<string | null>(null);

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
    });

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

    const showTooltip = (event: MapLayerMouseEvent): void => {
      const feature = event.features?.[0];
      if (!feature) {
        tooltip.style.display = 'none';
        return;
      }
      const score: unknown = feature.properties['score'];
      if (typeof score !== 'number') {
        tooltip.style.display = 'none';
        return;
      }
      const id: unknown = feature.properties['id'];
      const label = typeof id === 'number' ? String(id) : 'unknown';
      tooltip.textContent = `Score: ${scoreToPercent(score).toFixed(1)}% | Segment ${label}`;
      tooltip.style.display = 'block';
      tooltip.style.left = `${event.point.x}px`;
      tooltip.style.top = `${event.point.y}px`;
      tooltip.style.transform = 'translate(-50%, -100%) translateY(-10px)';
    };

    const hideTooltip = (): void => {
      tooltip.style.display = 'none';
    };

    // Load the manifest and register the snapshot layers.
    const loadSnapshot = async (): Promise<void> => {
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
      const entry = latestEntry(entries);
      const tilesUrl = entry.urls.segments;
      if (!tilesUrl) {
        setError(`The snapshot ${entry.date} has no tiles URL.`);
        return;
      }
      try {
        registerLayer(map, 'segments', {
          sourceId: 'segments-source',
          source: {
            type: 'vector',
            url: `pmtiles://${tilesUrl}`,
            minzoom: SEGMENTS_SOURCE_MINZOOM,
            maxzoom: SEGMENTS_SOURCE_MAXZOOM,
            attribution: `Robotability snapshot ${entry.date}`,
          },
          layer: {
            id: 'segments',
            type: 'line',
            source: 'segments-source',
            'source-layer': 'segments',
            paint: {
              'line-color': scoreColorExpression(),
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
              // Off by default. A later task toggles it on.
              layout: { visibility: 'none' },
              paint: {
                'line-color': 'rgba(100, 100, 100, 0.4)',
                'line-width': 1,
              },
            },
          });
        }
      } catch (err) {
        console.error('Map layer registration failed.', err);
        if (!disposed) setError('The map layers could not be added.');
      }
    };

    map.on('load', () => {
      void loadSnapshot();
    });

    map.on('mousemove', 'segments', showTooltip);
    map.on('mouseleave', 'segments', hideTooltip);
    map.on('mouseenter', 'segments', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'segments', () => {
      map.getCanvas().style.cursor = '';
    });

    // Watch the data-theme attribute on the html element. The theme
    // script and any future toggle write this attribute.
    const observer = new MutationObserver(() => {
      const theme = document.documentElement.getAttribute('data-theme');
      const nextStyleUrl = styleUrlForTheme(theme);
      if (nextStyleUrl === window.__robotabilityMapStyleUrl) return;
      switchStyle(map, nextStyleUrl);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => {
      disposed = true;
      observer.disconnect();
      if (window.__robotabilityMap === map) {
        delete window.__robotabilityMap;
      }
      delete window.__robotabilityMapStyleUrl;
      tooltip.remove();
      map.remove();
    };
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
      <div ref={containerRef} className="absolute inset-0" />
    </div>
  );
}
