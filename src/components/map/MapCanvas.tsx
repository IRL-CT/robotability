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
  MapLayerMouseEvent,
} from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import BreakdownPanel from './BreakdownPanel';
import { SCORE_COLORS, SCORE_DOMAIN_MAX, SCORE_DOMAIN_MIN, type DeploymentSite } from './constants';
import {
  DEPLOYMENTS_LAYER_ID,
  deploymentEmbedUrl,
  deploymentLayerEntry,
  refreshDeploymentPaint,
} from './DeploymentMarkers';
import LayerControls, { type LayerVisibility, type ToggleableLayer } from './LayerControls';
import { type RegisteredLayer, type SnapshotEntry } from './types';

// Test hooks. Playwright reads the map instance and the active style URL
// from the window object to assert the map state. The double-underscore
// names mark them as internal. They are not a public API.
declare global {
  interface Window {
    __robotabilityMap?: MapLibreMap;
    __robotabilityMapStyleUrl?: string;
    // T10 stub. Switches the active snapshot by manifest date. The time
    // scrubber task replaces this hook with real UI.
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
const SEGMENTS_SOURCE_MINZOOM = 9;
const SEGMENTS_SOURCE_MAXZOOM = 14;
const CENSUS_SOURCE_MINZOOM = 4;
const CENSUS_SOURCE_MAXZOOM = 14;

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
  const restore = (): void => {
    if (!map.isStyleLoaded()) {
      map.once('styledata', restore);
      return;
    }
    try {
      applyRegisteredLayers(map);
      afterRestore(map);
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

  // The error message for the visible banner. null means no error.
  const [error, setError] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<LayerVisibility>(DEFAULT_VISIBILITY);
  const [activeEntry, setActiveEntry] = useState<SnapshotEntry | null>(null);
  const [panelSegment, setPanelSegment] = useState<PanelSegment | null>(null);
  const [sidebarVideo, setSidebarVideo] = useState<SidebarVideo | null>(null);

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
    mapRef.current = map;

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

    const positionTooltip = (event: MapLayerMouseEvent, text: string): void => {
      tooltip.textContent = text;
      tooltip.style.display = 'block';
      tooltip.style.left = `${event.point.x}px`;
      tooltip.style.top = `${event.point.y}px`;
      tooltip.style.transform = 'translate(-50%, -100%) translateY(-10px)';
    };

    const hideTooltip = (): void => {
      tooltip.style.display = 'none';
    };

    const showSegmentTooltip = (event: MapLayerMouseEvent): void => {
      const feature = event.features?.[0];
      if (!feature) {
        hideTooltip();
        return;
      }
      const score: unknown = feature.properties['score'];
      if (typeof score !== 'number') {
        hideTooltip();
        return;
      }
      const id: unknown = feature.properties['id'];
      const label = typeof id === 'number' ? String(id) : 'unknown';
      positionTooltip(event, `Score: ${scoreToPercent(score).toFixed(1)}% | Segment ${label}`);
    };

    const showDeploymentTooltip = (event: MapLayerMouseEvent): void => {
      const feature = event.features?.[0];
      const name: unknown = feature?.properties['name'];
      if (typeof name !== 'string') {
        hideTooltip();
        return;
      }
      positionTooltip(event, name);
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
      if (map.isStyleLoaded()) {
        run();
      } else {
        map.once('styledata', run);
      }
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
      applySnapshot(latestEntry(entries));
    };

    // T10 stub. Switch the active snapshot by manifest date. The time
    // scrubber task replaces this hook with real UI.
    window.__robotabilityLoadSnapshot = (date: string): void => {
      const entry = manifestRef.current.find((candidate) => candidate.date === date);
      if (!entry) {
        console.warn(`No snapshot with date ${date} exists in the manifest.`);
        return;
      }
      applySnapshot(entry);
    };

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

    map.on('mousemove', 'segments', showSegmentTooltip);
    map.on('mouseleave', 'segments', hideTooltip);
    map.on('mouseenter', 'segments', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'segments', () => {
      map.getCanvas().style.cursor = '';
    });
    map.on('click', 'segments', handleSegmentClick);

    map.on('mousemove', 'deployments', showDeploymentTooltip);
    map.on('mouseleave', 'deployments', hideTooltip);
    map.on('mouseenter', 'deployments', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'deployments', () => {
      map.getCanvas().style.cursor = '';
    });
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

    return () => {
      disposed = true;
      observer.disconnect();
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
      />

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
