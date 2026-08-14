// DeploymentMarkers builds the map layer for the four deployment sites.
// The layer registers through the MapCanvas layer registry, so it
// survives a theme switch. The fill color follows the theme accent.
import { DEPLOYMENTS, type DeploymentSite } from './constants';
import type { RegisteredLayer } from './types';

export const DEPLOYMENTS_SOURCE_ID = 'deployments-source';
export const DEPLOYMENTS_LAYER_ID = 'deployments';

// One deployment marker as a GeoJSON feature. constants.ts stores coords
// in the legacy [lat, lon] order. GeoJSON needs [lon, lat], so this
// swaps the pair.
export type DeploymentFeature = {
  type: 'Feature';
  geometry: {
    type: 'Point';
    coordinates: [number, number];
  };
  properties: {
    name: string;
    videoId: string;
    startTime: number;
    endTime: number;
  };
};

export function deploymentFeatures(): DeploymentFeature[] {
  return Object.entries(DEPLOYMENTS).map(([name, site]) => ({
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [site.coords[1], site.coords[0]],
    },
    properties: {
      name,
      videoId: site.videoId,
      startTime: site.startTime,
      endTime: site.endTime,
    },
  }));
}

// The marker fill reads the theme accent CSS variable. tokens.css stores
// the value as an RGB triplet like "0, 108, 172". Wrap it in rgba() and
// append the opacity.
export function accentFillColor(opacity: number): string {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--color-accent')
    .trim();
  return `rgba(${raw}, ${opacity})`;
}

// The registry entry for the marker layer. Circle radius is 20px. The
// fill is the accent color at 0.6 opacity.
export function deploymentLayerEntry(): RegisteredLayer {
  return {
    sourceId: DEPLOYMENTS_SOURCE_ID,
    source: {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: deploymentFeatures(),
      },
    },
    layer: {
      id: DEPLOYMENTS_LAYER_ID,
      type: 'circle',
      source: DEPLOYMENTS_SOURCE_ID,
      paint: {
        'circle-radius': 20,
        'circle-color': accentFillColor(0.6),
        'circle-stroke-width': 2,
        'circle-stroke-color': 'rgba(255, 255, 255, 0.9)',
      },
    },
  };
}

// Re-read the accent variable and repaint the markers. Call this after a
// theme switch. The new theme changes the CSS variable value.
export function refreshDeploymentPaint(map: {
  getLayer(id: string): unknown;
  setPaintProperty(layerId: string, name: string, value: unknown): void;
}): void {
  if (!map.getLayer(DEPLOYMENTS_LAYER_ID)) return;
  map.setPaintProperty(DEPLOYMENTS_LAYER_ID, 'circle-color', accentFillColor(0.6));
}

// The sidebar YouTube embed URL. The pattern matches the legacy map in
// RobotabilityMap.jsx. Do not change the parameter set or order.
export function deploymentEmbedUrl(site: DeploymentSite): string {
  const base = `https://www.youtube-nocookie.com/embed/${site.videoId}`;
  const params = `start=${site.startTime}&end=${site.endTime}&rel=0&modestbranding=1&autoplay=1&enablejsapi=1`;
  return `${base}?${params}&origin=${window.location.origin}`;
}
