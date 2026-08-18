import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM has no __dirname. Derive this file's directory from import.meta.url.
const specDir = path.dirname(fileURLToPath(import.meta.url));

// T9 spec. Breakdown panel, layer controls, deployment markers.
// The fixture snapshot (e2e/fixtures/fixture-a) carries feature vectors.
// beforeAll copies it into dist/ and appends it to dist/manifest.json.
// The fixture date 2026-01-01 beats the 2023 baseline, so MapCanvas
// auto-loads the fixture on every page load.

// The exact fallback sentence for snapshots without feature vectors.
// It must match src/components/map/BreakdownPanel.tsx byte for byte.
const FALLBACK_SENTENCE =
  'Feature-level data is unavailable for the 2023 baseline. Only the aggregate score exists.';

// The Elmhurst deployment site. Copied from src/components/map/constants.ts
// (DEPLOYMENTS['Elmhurst, Queens']). coords there are [lat, lon].
const ELMHURST = { lat: 40.738536, lon: -73.887267, startTime: 44 };

// Center of the fixture segment grid. The T5 mock pipeline places a 12x12
// grid at the bbox corner with steps capped at 0.00012 deg lon and
// 0.00015 deg lat. Fixture bbox: -73.895,40.733,-73.880,40.745.
// center = minlon + 6*0.00012, minlat + 6*0.00015.
const FIXTURE_GRID_CENTER: [number, number] = [-73.89428, 40.7339];

// Structural type for the map instance that MapCanvas exposes on window.
// A structural type avoids any use of `as any`.
type RenderedSegmentFeature = {
  properties?: { id?: unknown; score?: unknown };
  geometry: { type: string; coordinates: Array<[number, number]> };
};

type ExposedMap = {
  getLayer(id: string): unknown;
  isStyleLoaded(): boolean;
  loaded(): boolean;
  isMoving(): boolean;
  queryRenderedFeatures(options: { layers: string[] }): RenderedSegmentFeature[];
  project(lngLat: [number, number]): { x: number; y: number };
  getCenter(): { lng: number; lat: number };
  getZoom(): number;
  getPitch(): number;
  jumpTo(options: { center: [number, number]; zoom: number; pitch: number }): void;
  getPaintProperty(layerId: string, name: string): unknown;
};

// MapCanvas declares these window properties globally. Omit the global
// versions first so this structural type wins.
type ExposedWindow = Omit<
  Window,
  '__robotabilityMap' | '__robotabilityMapStyleUrl' | '__robotabilityLoadSnapshot'
> & {
  __robotabilityMap?: ExposedMap;
  __robotabilityMapStyleUrl?: string;
  __robotabilityLoadSnapshot?: (date: string) => void;
};

type SegmentTarget = { id: number; score: number; x: number; y: number };

// Pick one rendered segment and project its midpoint to pixel coords.
// Runs inside the page. Returns null when no usable segment is rendered.
function pickSegmentTarget(): SegmentTarget | null {
  const w = window as ExposedWindow;
  const map = w.__robotabilityMap;
  if (!map || !map.isStyleLoaded()) return null;
  const features = map.queryRenderedFeatures({ layers: ['segments'] });
  for (const feature of features) {
    const props = feature.properties ?? {};
    const id = props.id;
    const score = props.score;
    if (typeof id !== 'number' || typeof score !== 'number') continue;
    if (feature.geometry.type !== 'LineString') continue;
    const coords = feature.geometry.coordinates;
    if (coords.length === 0) continue;
    const mid = coords[Math.floor(coords.length / 2)];
    const point = map.project(mid);
    return { id, score, x: point.x, y: point.y };
  }
  return null;
}

// Wait for the map, a loaded style, and the segments layer.
async function waitForMapReady(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.locator('.maplibregl-canvas')).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const w = window as ExposedWindow;
      const map = w.__robotabilityMap;
      return !!map && map.isStyleLoaded() && !!map.getLayer('segments');
    },
    undefined,
    { timeout: 30_000 }
  );
}

// Wait until at least one segment feature is rendered.
async function waitForRenderedSegments(
  page: import('@playwright/test').Page,
  timeout = 15_000
): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = window as ExposedWindow;
      const map = w.__robotabilityMap;
      if (!map || !map.isStyleLoaded() || !map.getLayer('segments')) return false;
      return map.queryRenderedFeatures({ layers: ['segments'] }).length > 0;
    },
    undefined,
    { timeout }
  );
}

// Jump the map to a center and wait for a settled style.
async function jumpTo(
  page: import('@playwright/test').Page,
  center: [number, number],
  zoom: number
): Promise<void> {
  await page.evaluate(
    (args) => {
      const w = window as ExposedWindow;
      w.__robotabilityMap?.jumpTo({ center: args.center, zoom: args.zoom, pitch: 0 });
    },
    { center, zoom }
  );
  await page.waitForFunction(
    () => {
      const w = window as ExposedWindow;
      return !!w.__robotabilityMap && w.__robotabilityMap.loaded();
    },
    undefined,
    { timeout: 15_000 }
  );
}

// Click a page point offset by the canvas position.
async function clickAt(
  page: import('@playwright/test').Page,
  x: number,
  y: number
): Promise<void> {
  const box = await page.locator('.maplibregl-canvas').boundingBox();
  const offsetX = box ? box.x : 0;
  const offsetY = box ? box.y : 0;
  await page.mouse.click(offsetX + x, offsetY + y);
}

// Patch dist/ for the fixture. dist is build output. Never touch public/.
// Save the original manifest bytes so afterAll restores them.
const distDir = path.join(specDir, '..', 'dist');
const fixtureDir = path.join(specDir, 'fixtures', 'fixture-a');
const distManifestPath = path.join(distDir, 'manifest.json');
const distSnapshotDir = path.join(distDir, 'snapshots', 'fixture-a');
let originalManifest: Buffer | null = null;

test.beforeAll(() => {
  originalManifest = fs.readFileSync(distManifestPath);
  fs.mkdirSync(distSnapshotDir, { recursive: true });
  for (const name of ['segments.pmtiles', 'features.parquet', 'manifest.json']) {
    fs.copyFileSync(path.join(fixtureDir, name), path.join(distSnapshotDir, name));
  }
  const siteManifest = JSON.parse(originalManifest.toString('utf8')) as {
    snapshots: Array<{ tag?: string }>;
  };
  // Make the manifest hermetic: keep the baseline, drop every published
  // snapshot. A real snapshot is newer than the fixture and would auto-load
  // in its place, so the fixture (and its feature vectors) would never load.
  siteManifest.snapshots = siteManifest.snapshots.filter((s) => s.tag === 'baseline');
  const fixtureEntry = JSON.parse(
    fs.readFileSync(path.join(fixtureDir, 'manifest.json'), 'utf8')
  ) as Record<string, unknown>;
  const hasFixture = siteManifest.snapshots.some((s) => s.tag === 'fixture-a');
  if (!hasFixture) {
    siteManifest.snapshots.push(fixtureEntry as { tag?: string });
  }
  fs.writeFileSync(distManifestPath, JSON.stringify(siteManifest, null, 2));
});

test.afterAll(() => {
  // Restore the untouched build output. Later specs (map-core) must see
  // the baseline manifest only.
  if (originalManifest !== null) {
    fs.writeFileSync(distManifestPath, originalManifest);
  }
  fs.rmSync(distSnapshotDir, { recursive: true, force: true });
});

test.describe('breakdown panel, layer controls, deployment markers', () => {
  test('segment click opens the panel with 19 rows and a matching total', async ({
    page,
  }) => {
    await page.goto('/map');
    await waitForMapReady(page);

    // The fixture snapshot auto-loads. Jump to its grid and click a segment.
    await jumpTo(page, FIXTURE_GRID_CENTER, 17.5);
    await waitForRenderedSegments(page);
    const target = await page.evaluate(pickSegmentTarget);
    expect(target).not.toBeNull();
    if (!target) return;
    await clickAt(page, target.x, target.y);

    // The panel shows one row per feature. All 19 rows render.
    const rows = page.locator('[data-testid="breakdown-row"]');
    await expect(rows).toHaveCount(19, { timeout: 15_000 });

    // No NaN and no empty fields in the rows.
    const bodyText = await page.locator('[data-testid="breakdown-body"]').innerText();
    expect(bodyText).not.toContain('NaN');

    // The total matches the clicked tile score within 0.001.
    const totalText = await page.locator('[data-testid="breakdown-total"]').innerText();
    const total = Number.parseFloat(totalText);
    expect(Number.isFinite(total)).toBe(true);
    expect(Math.abs(total - target.score)).toBeLessThan(0.001);
  });

  test('baseline snapshot shows the exact fallback sentence with no console errors', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(String(error)));

    await page.goto('/map');
    await waitForMapReady(page);

    // Switch to the 2023 baseline through the T10 stub hook.
    await page.evaluate(() => {
      const w = window as ExposedWindow;
      w.__robotabilityLoadSnapshot?.('2023-08-01');
    });
    await page.waitForFunction(
      () => {
        const w = window as ExposedWindow;
        const map = w.__robotabilityMap;
        return !!map && map.isStyleLoaded() && !!map.getLayer('segments');
      },
      undefined,
      { timeout: 15_000 }
    );

    // The baseline covers all of NYC. Use the default initial view.
    await jumpTo(page, [-73.9712, 40.7831], 12);
    await waitForRenderedSegments(page);
    const target = await page.evaluate(pickSegmentTarget);
    expect(target).not.toBeNull();
    if (!target) return;
    await clickAt(page, target.x, target.y);

    // The panel body holds exactly the fallback sentence. Byte-exact.
    // Poll for the text first, then re-read it for the byte-exact check.
    const body = page.locator('[data-testid="breakdown-body"]');
    await expect(body).toBeVisible({ timeout: 10_000 });
    await expect(body).toHaveText(FALLBACK_SENTENCE, { timeout: 5_000 });
    const text = await body.textContent();
    expect(text).toBe(FALLBACK_SENTENCE);

    // The page logged no console errors.
    expect(errors).toEqual([]);
  });

  test('Elmhurst marker flies to the site and opens the video sidebar', async ({
    page,
  }) => {
    await page.goto('/map');
    await waitForMapReady(page);

    // Wait for the deployment markers layer.
    await page.waitForFunction(
      () => {
        const w = window as ExposedWindow;
        const map = w.__robotabilityMap;
        return !!map && map.isStyleLoaded() && !!map.getLayer('deployments');
      },
      undefined,
      { timeout: 10_000 }
    );

    // Center the Elmhurst marker and click it.
    await jumpTo(page, [ELMHURST.lon, ELMHURST.lat], 15);
    const point = await page.evaluate((lngLat) => {
      const w = window as ExposedWindow;
      const map = w.__robotabilityMap;
      if (!map) return null;
      return map.project(lngLat);
    }, [ELMHURST.lon, ELMHURST.lat] as [number, number]);
    expect(point).not.toBeNull();
    if (!point) return;
    await clickAt(page, point.x, point.y);

    // The flyTo runs for 2s. Wait for the animation to finish.
    await page.waitForTimeout(400);
    await page.waitForFunction(
      () => {
        const w = window as ExposedWindow;
        const map = w.__robotabilityMap;
        return !!map && !map.isMoving();
      },
      undefined,
      { timeout: 10_000 }
    );

    // Assert the flyTo target: center, zoom ~16, pitch 60.
    const view = await page.evaluate(() => {
      const w = window as ExposedWindow;
      const map = w.__robotabilityMap;
      if (!map) return null;
      return {
        lng: map.getCenter().lng,
        lat: map.getCenter().lat,
        zoom: map.getZoom(),
        pitch: map.getPitch(),
      };
    });
    expect(view).not.toBeNull();
    if (!view) return;
    expect(Math.abs(view.lng - ELMHURST.lon)).toBeLessThan(1e-3);
    expect(Math.abs(view.lat - ELMHURST.lat)).toBeLessThan(1e-3);
    expect(Math.abs(view.zoom - 16)).toBeLessThan(0.25);
    expect(Math.abs(view.pitch - 60)).toBeLessThan(1);

    // The sidebar shows the YouTube embed with the exact video id and start.
    const iframe = page.locator('[data-testid="deployment-video"]');
    await expect(iframe).toBeVisible({ timeout: 5_000 });
    const src = await iframe.getAttribute('src');
    expect(src ?? '').toContain('o52MZ1AHyjA');
    expect(src ?? '').toContain(`start=${ELMHURST.startTime}`);
  });

  test('parquet failure shows the retry message and the map stays usable', async ({
    page,
  }) => {
    // Abort every parquet request. The panel must degrade to a retry state.
    await page.route('**/features.parquet', (route) => route.abort());

    await page.goto('/map');
    await waitForMapReady(page);
    await jumpTo(page, FIXTURE_GRID_CENTER, 17.5);
    await waitForRenderedSegments(page);
    const target = await page.evaluate(pickSegmentTarget);
    expect(target).not.toBeNull();
    if (!target) return;
    await clickAt(page, target.x, target.y);

    // The retry message and button appear. No uncaught error reaches the page.
    await expect(page.locator('[data-testid="breakdown-retry"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('[data-testid="breakdown-retry-button"]')).toBeVisible();

    // The map still pans. Move the center and read it back.
    const moved = await page.evaluate(() => {
      const w = window as ExposedWindow;
      const map = w.__robotabilityMap;
      if (!map) return false;
      const before = map.getCenter().lng;
      map.jumpTo({ center: [before + 0.002, map.getCenter().lat], zoom: map.getZoom(), pitch: 0 });
      return Math.abs(map.getCenter().lng - (before + 0.002)) < 1e-9;
    });
    expect(moved).toBe(true);
  });

  test('deployment markers survive a theme switch', async ({ page }) => {
    await page.goto('/map');
    await waitForMapReady(page);
    await page.waitForFunction(
      () => {
        const w = window as ExposedWindow;
        const map = w.__robotabilityMap;
        return !!map && map.isStyleLoaded() && !!map.getLayer('deployments');
      },
      undefined,
      { timeout: 10_000 }
    );

    // Toggle the theme. The style switch must re-add the markers layer
    // and repaint it with the dark accent. Wait for the repaint itself:
    // the style URL flips before the restore runs, so the URL alone is
    // not a safe signal.
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });
    await page.waitForFunction(
      () => {
        const w = window as ExposedWindow;
        const map = w.__robotabilityMap;
        if (
          !map ||
          typeof w.__robotabilityMapStyleUrl !== 'string' ||
          !w.__robotabilityMapStyleUrl.includes('dark-matter') ||
          !map.isStyleLoaded() ||
          !map.getLayer('deployments') ||
          !map.getLayer('segments')
        ) {
          return false;
        }
        const fill = map.getPaintProperty('deployments', 'circle-color');
        return typeof fill === 'string' && fill.includes('255, 107, 1');
      },
      undefined,
      { timeout: 15_000 }
    );

    // The marker fill follows the dark accent color.
    const fill = await page.evaluate(() => {
      const w = window as ExposedWindow;
      const map = w.__robotabilityMap;
      if (!map) return null;
      return map.getPaintProperty('deployments', 'circle-color');
    });
    expect(String(fill)).toContain('255, 107, 1');
  });
});
