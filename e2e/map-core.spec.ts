import { test, expect } from '@playwright/test';

// Core map checks. The map page must use the PMTiles + maplibre core.
// It must not use deck.gl and it must not fetch the legacy sidewalks.geojson.

// Shape of the probe that runs inside the page. It reads the map instance
// that MapCanvas exposes as window.__robotabilityMap for testability.
type MapProbe = {
  hasMap: boolean;
  styleUrl: string | null;
  styleName: string | null;
  styleLoaded: boolean;
  hasSegmentsLayer: boolean;
  featureCount: number;
  centerLng: number;
  centerLat: number;
  zoom: number;
};

// Minimal structural type for the exposed map instance. The spec only needs
// these methods. A structural type avoids any use of `as any`.
type ExposedMap = {
  getLayer(id: string): unknown;
  getStyle(): { name?: string };
  isStyleLoaded(): boolean;
  loaded(): boolean;
  queryRenderedFeatures(options: { layers: string[] }): Array<{
    properties?: { id?: number };
  }>;
  getCenter(): { lng: number; lat: number };
  getZoom(): number;
};

// The MapCanvas component also declares these window properties globally.
// Omit the global versions first so this structural type wins.
type ExposedWindow = Omit<
  Window,
  '__robotabilityMap' | '__robotabilityMapStyleUrl'
> & {
  __robotabilityMap?: ExposedMap;
  __robotabilityMapStyleUrl?: string;
};

// Read the map state inside the page. Return a flat object the test can assert.
function probeMap(): MapProbe {
  const w = window as ExposedWindow;
  const map = w.__robotabilityMap;
  if (!map) {
    return {
      hasMap: false,
      styleUrl: null,
      styleName: null,
      styleLoaded: false,
      hasSegmentsLayer: false,
      featureCount: 0,
      centerLng: 0,
      centerLat: 0,
      zoom: 0,
    };
  }
  const styleLoaded = map.isStyleLoaded();
  let featureCount = 0;
  if (styleLoaded && map.getLayer('segments')) {
    // Count unique segment ids. Tile edge duplicates share one id.
    const seen = new Set<number>();
    const features = map.queryRenderedFeatures({ layers: ['segments'] });
    for (const feature of features) {
      const id = feature.properties?.id;
      if (typeof id === 'number') seen.add(id);
    }
    featureCount = seen.size;
  }
  const center = map.getCenter();
  return {
    hasMap: true,
    styleUrl: w.__robotabilityMapStyleUrl ?? null,
    styleName: map.getStyle().name ?? null,
    styleLoaded,
    hasSegmentsLayer: map.getLayer('segments') !== undefined,
    featureCount,
    centerLng: center.lng,
    centerLat: center.lat,
    zoom: map.getZoom(),
  };
}

test.describe('map core (PMTiles + maplibre)', () => {
  test('map canvas renders, segments.pmtiles loads, sidewalks.geojson never loads', async ({
    page,
  }) => {
    const requestUrls: string[] = [];
    page.on('request', (request) => requestUrls.push(request.url()));

    await page.goto('/map');

    // The maplibre canvas must render. A white screen fails the test.
    await expect(page.locator('.maplibregl-canvas')).toBeVisible({
      timeout: 30_000,
    });

    // The map must request the PMTiles snapshot archive.
    await expect
      .poll(() => requestUrls.some((url) => url.includes('segments.pmtiles')), {
        timeout: 30_000,
      })
      .toBe(true);

    // The legacy 96 MB GeoJSON must never load.
    expect(
      requestUrls.some((url) => url.includes('sidewalks.geojson'))
    ).toBe(false);
  });

  test('dark theme switches the basemap style and keeps the segments layer and view', async ({
    page,
  }) => {
    await page.goto('/map');

    await expect(page.locator('.maplibregl-canvas')).toBeVisible({
      timeout: 30_000,
    });

    // Wait for the exposed map, a loaded style, and the segments layer.
    await page.waitForFunction(
      () => {
        const w = window as ExposedWindow;
        const map = w.__robotabilityMap;
        return !!map && map.isStyleLoaded() && !!map.getLayer('segments');
      },
      undefined,
      { timeout: 30_000 }
    );

    // Wait until the map is idle so all visible tiles are loaded.
    await page.waitForFunction(
      () => {
        const w = window as ExposedWindow;
        return !!w.__robotabilityMap && w.__robotabilityMap.loaded();
      },
      undefined,
      { timeout: 30_000 }
    );

    const before = await page.evaluate(probeMap);
    expect(before.hasMap).toBe(true);
    expect(before.hasSegmentsLayer).toBe(true);
    expect(before.featureCount).toBeGreaterThan(0);

    // Switch the theme. The MutationObserver in MapCanvas must react.
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });

    // Wait for the dark basemap style to load with the segments layer intact.
    await page.waitForFunction(
      () => {
        const w = window as ExposedWindow;
        const map = w.__robotabilityMap;
        return (
          !!map &&
          typeof w.__robotabilityMapStyleUrl === 'string' &&
          w.__robotabilityMapStyleUrl.includes('dark-matter') &&
          map.isStyleLoaded() &&
          !!map.getLayer('segments')
        );
      },
      undefined,
      { timeout: 30_000 }
    );

    // Wait for idle again so the tile counts are comparable.
    await page.waitForFunction(
      () => {
        const w = window as ExposedWindow;
        return !!w.__robotabilityMap && w.__robotabilityMap.loaded();
      },
      undefined,
      { timeout: 30_000 }
    );

    const after = await page.evaluate(probeMap);

    // The style URL must point at the dark basemap.
    expect(after.styleUrl).toContain('dark-matter');
    // The segments layer must survive the style switch.
    expect(after.hasSegmentsLayer).toBe(true);
    // The feature count must not change.
    expect(after.featureCount).toBe(before.featureCount);
    // The view must not move. Epsilon covers float rounding.
    expect(Math.abs(after.centerLng - before.centerLng)).toBeLessThan(1e-4);
    expect(Math.abs(after.centerLat - before.centerLat)).toBeLessThan(1e-4);
    expect(Math.abs(after.zoom - before.zoom)).toBeLessThan(1e-3);
  });
});
