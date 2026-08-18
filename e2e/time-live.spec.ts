import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parquetReadObjects } from 'hyparquet';

// T10 spec. Time scrubber, play animation, A/B diff mode, and the
// opt-in live refresh. Also carries the census registration regression
// test for the MapCanvas registerLayer queue fix.

// ESM has no __dirname. Derive this file's directory from import.meta.url.
const specDir = path.dirname(fileURLToPath(import.meta.url));

// The fixture grids. The T5 mock pipeline places a 12x12 grid at the
// bbox corner. Fixture bbox: -73.895,40.733,-73.880,40.745. Both
// fixtures share the bbox, so both cover the same 144 segment ids.
const FIXTURE_BBOX = { minLon: -73.895, minLat: 40.733, maxLon: -73.88, maxLat: 40.745 };
const FIXTURE_GRID_CENTER: [number, number] = [-73.89428, 40.7339];

const DATE_A = '2026-01-01'; // fixture-a
const DATE_B = '2026-02-01'; // fixture-b
const DATE_BASELINE = '2023-08-01';

// Exact UI sentences. TimePanel.tsx must emit them byte for byte.
const ZOOM_SENTENCE = 'Zoom in to refresh a smaller area.';
const DISABLED_SENTENCE = 'Live refresh is unavailable. Showing the latest snapshot.';

// Structural types for the window hooks. They avoid any use of `as any`.
type RenderedFeature = {
  properties?: { id?: unknown; score?: unknown };
  geometry: { type: string; coordinates: Array<[number, number]> };
};

type ExposedMap = {
  getLayer(id: string): unknown;
  getLayoutProperty(layerId: string, name: string): unknown;
  isStyleLoaded(): boolean;
  loaded(): boolean;
  isMoving(): boolean;
  queryRenderedFeatures(options: { layers: string[] }): RenderedFeature[];
  project(lngLat: [number, number]): { x: number; y: number };
  getCenter(): { lng: number; lat: number };
  getZoom(): number;
  jumpTo(options: { center: [number, number]; zoom: number; pitch: number }): void;
};

type DiffHook = {
  active: boolean;
  dateA: string | null;
  dateB: string | null;
  deltas: Array<{ id: number; delta: number }>;
  minDelta: number | null;
  maxDelta: number | null;
};

type LiveHook = {
  active: boolean;
  results: Array<
    | { id: number; status: 'scored'; snapshotScore: number; liveScore: number; delta: number }
    | { id: number; status: 'unavailable' }
  >;
};

type TimeHook = {
  dates: string[];
  activeDate: string | null;
  playing: boolean;
};

type ExposedWindow = Omit<
  Window,
  | '__robotabilityMap'
  | '__robotabilityMapStyleUrl'
  | '__robotabilityLoadSnapshot'
  | '__robotabilityTimeState'
  | '__robotabilityDiffState'
  | '__robotabilityLiveState'
> & {
  __robotabilityMap?: ExposedMap;
  __robotabilityMapStyleUrl?: string;
  __robotabilityLoadSnapshot?: (date: string) => void;
  __robotabilityTimeState?: TimeHook;
  __robotabilityDiffState?: DiffHook;
  __robotabilityLiveState?: LiveHook;
};

// ---------------------------------------------------------------------
// dist patching. The spec copies both fixtures into dist/ and appends
// their manifest entries to dist/manifest.json. afterAll restores the
// original manifest bytes and removes both fixture dirs. See the
// test.beforeAll block at line ~150 and test.afterAll at line ~190.
// ---------------------------------------------------------------------

const distDir = path.join(specDir, '..', 'dist');
const distManifestPath = path.join(distDir, 'manifest.json');
let originalManifest: Buffer | null = null;

function patchDist(): void {
  originalManifest = fs.readFileSync(distManifestPath);
  const siteManifest = JSON.parse(originalManifest.toString('utf8')) as {
    snapshots: Array<Record<string, unknown>>;
  };
  // Make the manifest hermetic: keep the baseline, drop every published
  // snapshot. A real snapshot (e.g. 2026-08-18) is newer than the fixtures
  // and would auto-load in their place, breaking the date assertions below.
  siteManifest.snapshots = siteManifest.snapshots.filter(
    (snapshot) => snapshot['date'] === DATE_BASELINE
  );
  for (const tag of ['fixture-a', 'fixture-b']) {
    const fixtureDir = path.join(specDir, 'fixtures', tag);
    const distSnapshotDir = path.join(distDir, 'snapshots', tag);
    fs.mkdirSync(distSnapshotDir, { recursive: true });
    for (const name of fs.readdirSync(fixtureDir)) {
      fs.copyFileSync(path.join(fixtureDir, name), path.join(distSnapshotDir, name));
    }
    const entry = JSON.parse(
      fs.readFileSync(path.join(fixtureDir, 'manifest.json'), 'utf8')
    ) as Record<string, unknown>;
    const present = siteManifest.snapshots.some((snapshot) => snapshot['tag'] === tag);
    if (!present) {
      siteManifest.snapshots.push(entry);
    }
  }
  fs.writeFileSync(distManifestPath, JSON.stringify(siteManifest, null, 2));
}

function restoreDist(): void {
  // Restore the untouched build output. Later specs must see the
  // baseline manifest only. The original bytes come from patchDist.
  if (originalManifest !== null) {
    fs.writeFileSync(distManifestPath, originalManifest);
  }
  for (const tag of ['fixture-a', 'fixture-b']) {
    fs.rmSync(path.join(distDir, 'snapshots', tag), { recursive: true, force: true });
  }
}

test.beforeAll(() => {
  patchDist();
});

test.afterAll(() => {
  restoreDist();
});

// ---------------------------------------------------------------------
// Page helpers.
// ---------------------------------------------------------------------

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

// Read the active date from the time hook.
async function activeDate(page: import('@playwright/test').Page): Promise<string | null> {
  return page.evaluate(() => {
    const w = window as ExposedWindow;
    return w.__robotabilityTimeState?.activeDate ?? null;
  });
}

// Move the scrubber to one date. The scrubber maps sorted manifest
// entries onto range indices. The value goes through the native setter:
// React's value tracker ignores a direct .value write, so the change
// event would never reach the onChange handler.
async function scrubToDate(
  page: import('@playwright/test').Page,
  date: string
): Promise<void> {
  await page.evaluate((target) => {
    const w = window as ExposedWindow;
    const dates = w.__robotabilityTimeState?.dates ?? [];
    const index = dates.indexOf(target);
    const input = document.querySelector('[data-testid="time-scrubber"]');
    if (!(input instanceof HTMLInputElement) || index < 0) {
      throw new Error(`The scrubber is missing or has no date ${target}.`);
    }
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set;
    if (!setter) {
      throw new Error('The native range value setter is missing.');
    }
    setter.call(input, String(index));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, date);
  await page.waitForFunction(
    (wanted) => {
      const w = window as ExposedWindow;
      return w.__robotabilityTimeState?.activeDate === wanted;
    },
    date,
    { timeout: 15_000 }
  );
  // The snapshot switch swaps the tile source. Wait for the new tiles.
  await page.waitForFunction(
    () => {
      const w = window as ExposedWindow;
      return !!w.__robotabilityMap && w.__robotabilityMap.loaded();
    },
    undefined,
    { timeout: 15_000 }
  );
}

// Sample the rendered segment scores. One entry per unique segment id.
async function sampleScores(
  page: import('@playwright/test').Page
): Promise<Array<{ id: number; score: number }>> {
  return page.evaluate(() => {
    const w = window as ExposedWindow;
    const map = w.__robotabilityMap;
    if (!map) return [];
    const seen = new Map<number, number>();
    const features = map.queryRenderedFeatures({ layers: ['segments'] });
    for (const feature of features) {
      const id = feature.properties?.id;
      const score = feature.properties?.score;
      if (typeof id === 'number' && typeof score === 'number' && !seen.has(id)) {
        seen.set(id, score);
      }
    }
    return Array.from(seen.entries()).map(([id, score]) => ({ id, score }));
  });
}

// The 144 mock-grid midpoints. The canned SODA rows sit on these points
// so the nearest-anchor assignment hits every segment.
function gridMidpoints(): Array<{ lon: number; lat: number }> {
  const lonStep = Math.min((FIXTURE_BBOX.maxLon - FIXTURE_BBOX.minLon) / 12, 0.00012);
  const latStep = Math.min((FIXTURE_BBOX.maxLat - FIXTURE_BBOX.minLat) / 12, 0.00015);
  const points: Array<{ lon: number; lat: number }> = [];
  for (let row = 0; row < 12; row += 1) {
    for (let col = 0; col < 12; col += 1) {
      points.push({
        lon: FIXTURE_BBOX.minLon + lonStep * (col + 0.5),
        lat: FIXTURE_BBOX.minLat + latStep * (row + 0.5),
      });
    }
  }
  return points;
}

// Canned SODA rows for one dataset. Spatial rows carry latitude and
// longitude on every grid midpoint. The values differ from the fixture
// snapshot values, so the live scores must move.
function cannedRows(dataset: string): Array<Record<string, string | number>> {
  const points = gridMidpoints();
  const spatial = points.map((point, index) => ({
    latitude: point.lat,
    longitude: point.lon,
    marker: index,
  }));
  switch (dataset) {
    case '52n9-sdep':
      return spatial.map((row) => ({ ...row, shape_area: '30', shape_leng: '5' }));
    case 'rqhp-hivt':
      return [{ acceptable_streets_previous_month: '95' }];
    case 'kdig-pewd':
      return spatial.slice(0, 1).map((row) => ({ ...row, zonedist: 'M1-4' }));
    case 'mzxg-pwib':
      return spatial.slice(0, 1).map((row) => ({ ...row, facilitycl: 'III' }));
    case 'h9gi-nx95':
      return spatial.map((row) => ({
        ...row,
        number_of_pedestrians_injured: '2',
        number_of_pedestrians_killed: '0',
      }));
    case '5mad-ntua':
      return spatial.map((row) => ({ ...row, postvz_sl: '30' }));
    case 'qt6m-xctn':
      return [{ marker: 1 }, { marker: 2 }, { marker: 3 }];
    case 'sxx4-xhzg':
      return [{ marker: 1 }, { marker: 2 }];
    default:
      // Count-based datasets. One row per midpoint gives every segment
      // the value 1 for this dataset.
      return spatial;
  }
}

// Canned GBFS feed. Two stations inside the fixture bbox.
function cannedGbfs(): Record<string, unknown> {
  return {
    data: {
      stations: [
        { station_id: '1', name: 'Mock A', lat: 40.734, lon: -73.894 },
        { station_id: '2', name: 'Mock B', lat: 40.744, lon: -73.881 },
      ],
    },
  };
}

// Copy a Node buffer into a plain ArrayBuffer. hyparquet reads
// ArrayBuffer payloads, not Node buffers. The copy also avoids the
// pooled-buffer trap where buffer.buffer exceeds the view.
function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(buffer);
  return copy;
}

// Expected diff deltas read straight from the committed fixture
// parquets. delta = scoreB - scoreA, joined on segment_id.
async function expectedDeltas(): Promise<Map<number, number>> {
  const rowsA = await parquetReadObjects({
    file: toArrayBuffer(
      fs.readFileSync(path.join(specDir, 'fixtures', 'fixture-a', 'features.parquet'))
    ),
  });
  const rowsB = await parquetReadObjects({
    file: toArrayBuffer(
      fs.readFileSync(path.join(specDir, 'fixtures', 'fixture-b', 'features.parquet'))
    ),
  });
  const scoresA = new Map<number, number>();
  for (const row of rowsA) {
    scoresA.set(Number(row['segment_id']), Number(row['score']));
  }
  const deltas = new Map<number, number>();
  for (const row of rowsB) {
    const id = Number(row['segment_id']);
    const scoreA = scoresA.get(id);
    if (scoreA === undefined) continue;
    deltas.set(id, Number(row['score']) - scoreA);
  }
  return deltas;
}

// ---------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------

test.describe('time scrubber, diff mode, live refresh', () => {
  test('(a) census toggle works on a fresh load without a theme switch', async ({
    page,
  }) => {
    await page.goto('/map');
    await waitForMapReady(page);

    // The newest fixture auto-loads. It carries a census URL.
    expect(await activeDate(page)).toBe(DATE_B);

    // Toggle the census layer on through the layer controls.
    await page.getByLabel('Census blocks').check();

    // The census layer must exist, show visible, and render features.
    // Before the registerLayer queue fix the registration was dropped
    // during the tile-load window, so getLayer('census') stayed empty.
    await page.waitForFunction(
      () => {
        const w = window as ExposedWindow;
        const map = w.__robotabilityMap;
        if (!map || !map.getLayer('census')) return false;
        if (map.getLayoutProperty('census', 'visibility') !== 'visible') return false;
        return map.queryRenderedFeatures({ layers: ['census'] }).length > 0;
      },
      undefined,
      { timeout: 15_000 }
    );

    // No theme switch happened. The style URL still names the light map.
    const styleUrl = await page.evaluate(() => {
      const w = window as ExposedWindow;
      return w.__robotabilityMapStyleUrl ?? '';
    });
    expect(styleUrl).toContain('positron');
  });

  test('(b) the scrubber switches snapshot colors', async ({ page }) => {
    await page.goto('/map');
    await waitForMapReady(page);
    await jumpTo(page, FIXTURE_GRID_CENTER, 17.5);
    await waitForRenderedSegments(page);

    // Fresh load shows fixture-b, the newest snapshot.
    expect(await activeDate(page)).toBe(DATE_B);
    const scoresB = await sampleScores(page);
    expect(scoresB.length).toBeGreaterThan(0);

    // Scrub to fixture-a. The scores must change.
    await scrubToDate(page, DATE_A);
    await jumpTo(page, FIXTURE_GRID_CENTER, 17.5);
    await waitForRenderedSegments(page);
    const scoresA = await sampleScores(page);
    expect(scoresA.length).toBeGreaterThan(0);

    const byIdB = new Map(scoresB.map((entry) => [entry.id, entry.score]));
    let common = 0;
    let changed = 0;
    for (const entry of scoresA) {
      const before = byIdB.get(entry.id);
      if (before === undefined) continue;
      common += 1;
      if (Math.abs(before - entry.score) > 1e-6) changed += 1;
    }
    expect(common).toBeGreaterThan(0);
    expect(changed).toBeGreaterThan(0);
    expect(await activeDate(page)).toBe(DATE_A);
  });

  test('(c) play advances through the snapshots and stops at the last', async ({
    page,
  }) => {
    await page.goto('/map');
    await waitForMapReady(page);

    // Start at the oldest entry so play has two steps to take.
    await scrubToDate(page, DATE_BASELINE);

    // Click play and record the active-date sequence for 4 seconds.
    await page.click('[data-testid="play-button"]');
    const sequence: string[] = [];
    const deadline = Date.now() + 4_000;
    let last: string | null = null;
    while (Date.now() < deadline) {
      const current = await activeDate(page);
      if (current !== null && current !== last) {
        sequence.push(current);
        last = current;
      }
      await page.waitForTimeout(100);
    }

    // The walk covers baseline -> fixture-a -> fixture-b in order.
    expect(sequence).toEqual([DATE_BASELINE, DATE_A, DATE_B]);

    // Play stops at the last entry. The loop stays off.
    const state = await page.evaluate(() => {
      const w = window as ExposedWindow;
      return w.__robotabilityTimeState ?? null;
    });
    expect(state?.playing).toBe(false);
    expect(state?.activeDate).toBe(DATE_B);

    // Wait one more step window. The date must not move (no loop).
    await page.waitForTimeout(1_600);
    expect(await activeDate(page)).toBe(DATE_B);
  });

  test('(d) diff mode shows deltas only where the scores differ', async ({
    page,
  }) => {
    await page.goto('/map');
    await waitForMapReady(page);

    await page.click('[data-testid="diff-toggle"]');
    await page.selectOption('[data-testid="diff-a"]', DATE_A);
    await page.selectOption('[data-testid="diff-b"]', DATE_B);

    // Wait for the diff hook to fill.
    await page.waitForFunction(
      () => {
        const w = window as ExposedWindow;
        const diff = w.__robotabilityDiffState;
        return !!diff && diff.active && diff.deltas.length > 0;
      },
      undefined,
      { timeout: 20_000 }
    );

    const hook = await page.evaluate(() => {
      const w = window as ExposedWindow;
      return w.__robotabilityDiffState ?? null;
    });
    expect(hook).not.toBeNull();
    if (!hook) return;

    // Ground truth comes from the committed parquets.
    const expected = await expectedDeltas();
    expect(hook.deltas.length).toBe(expected.size);

    for (const entry of hook.deltas) {
      const want = expected.get(entry.id);
      expect(want).toBeDefined();
      if (want === undefined) continue;
      // Non-zero deltas appear only where the scores differ.
      if (Math.abs(want) <= 1e-6) {
        expect(Math.abs(entry.delta)).toBeLessThan(1e-6);
      } else {
        expect(Math.abs(entry.delta)).toBeGreaterThan(0);
      }
      expect(Math.abs(entry.delta - want)).toBeLessThan(1e-4);
    }

    // The legend shows the delta scale with min and max labels.
    const legend = page.locator('[data-testid="diff-legend"]');
    await expect(legend).toBeVisible();
    const legendText = (await legend.innerText()).replace(/\s+/g, ' ');
    expect(hook.minDelta).not.toBeNull();
    expect(hook.maxDelta).not.toBeNull();
    if (hook.minDelta !== null && hook.maxDelta !== null) {
      expect(legendText).toContain(hook.minDelta.toFixed(3));
      expect(legendText).toContain(hook.maxDelta.toFixed(3));
    }
  });

  test('(e) live refresh shows the LIVE badge and moves scores', async ({
    page,
  }) => {
    const sodaUrls: string[] = [];
    await page.route(/data\.cityofnewyork\.us/, async (route) => {
      sodaUrls.push(route.request().url());
      const url = new URL(route.request().url());
      const file = url.pathname.split('/').pop() ?? '';
      const dataset = file.split('.')[0];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(cannedRows(dataset)),
      });
    });
    await page.route(/gbfs\.citibikenyc\.com/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(cannedGbfs()),
      });
    });

    await page.goto('/map');
    await waitForMapReady(page);

    // Scrub to fixture-b. It carries feature_stats.
    await scrubToDate(page, DATE_B);

    // Live refresh is opt-in. No SODA request may leave before the click.
    expect(sodaUrls.length).toBe(0);

    // Zoom in so the viewport stays under the 8 km2 cap.
    await jumpTo(page, FIXTURE_GRID_CENTER, 16);
    await waitForRenderedSegments(page);

    await page.click('[data-testid="live-refresh-button"]');

    // The LIVE badge appears and names the approximation.
    const badge = page.locator('[data-testid="live-badge"]');
    await expect(badge).toBeVisible({ timeout: 30_000 });
    const badgeText = await badge.textContent();
    expect(badgeText ?? '').toContain('LIVE');
    expect(badgeText ?? '').toContain('approximate');

    // At least one segment score moved against its snapshot value.
    const live = await page.evaluate(() => {
      const w = window as ExposedWindow;
      return w.__robotabilityLiveState ?? null;
    });
    expect(live).not.toBeNull();
    if (!live) return;
    const moved = live.results.some(
      (entry) => entry.status === 'scored' && Math.abs(entry.delta) > 1e-4
    );
    expect(moved).toBe(true);
    expect(sodaUrls.length).toBeGreaterThan(0);
  });

  test('(f) a 429 answer shows the exact disabled sentence', async ({ page }) => {
    await page.route(/data\.cityofnewyork\.us/, async (route) => {
      await route.fulfill({ status: 429, body: 'rate limited' });
    });
    await page.route(/gbfs\.citibikenyc\.com/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(cannedGbfs()),
      });
    });

    await page.goto('/map');
    await waitForMapReady(page);
    await scrubToDate(page, DATE_B);
    await jumpTo(page, FIXTURE_GRID_CENTER, 16);
    await waitForRenderedSegments(page);

    await page.click('[data-testid="live-refresh-button"]');

    const banner = page.locator('[data-testid="live-banner"]');
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toHaveText(DISABLED_SENTENCE);
  });

  test('(h) diff mode paints the overlay layer with no console errors', async ({
    page,
  }) => {
    // Collect every console error and uncaught exception. The invalid
    // width expression made addLayer throw, and whenStyleReady logged
    // each failure with console.error.
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));

    await page.goto('/map');
    await waitForMapReady(page);

    // Put the fixture grid in view so the overlay has geometry.
    await jumpTo(page, FIXTURE_GRID_CENTER, 16);
    await waitForRenderedSegments(page);

    await page.click('[data-testid="diff-toggle"]');
    await page.selectOption('[data-testid="diff-a"]', DATE_A);
    await page.selectOption('[data-testid="diff-b"]', DATE_B);

    // Wait for the diff hook to fill.
    await page.waitForFunction(
      () => {
        const w = window as ExposedWindow;
        const diff = w.__robotabilityDiffState;
        return !!diff && diff.active && diff.deltas.length > 0;
      },
      undefined,
      { timeout: 20_000 }
    );

    // The overlay layer must exist on the map. Before the width
    // expression fix, addLayer threw and the layer never appeared.
    await page.waitForFunction(
      () => {
        const w = window as ExposedWindow;
        const map = w.__robotabilityMap;
        return !!map && !!map.getLayer('diff-overlay');
      },
      undefined,
      { timeout: 20_000 }
    );

    // The overlay must carry the rendered fixture segments.
    await page.waitForFunction(
      () => {
        const w = window as ExposedWindow;
        const map = w.__robotabilityMap;
        if (!map) return false;
        return map.queryRenderedFeatures({ layers: ['diff-overlay'] }).length > 0;
      },
      undefined,
      { timeout: 20_000 }
    );

    // No console error may fire during the whole diff activation.
    expect(consoleErrors).toEqual([]);
  });

  test('(i) live refresh paints the overlay layer with no console errors', async ({
    page,
  }) => {
    // Collect every console error and uncaught exception. The invalid
    // width expression made addLayer throw on the live overlay too.
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));

    // The mocked SODA and GBFS routes match test (e).
    await page.route(/data\.cityofnewyork\.us/, async (route) => {
      const url = new URL(route.request().url());
      const file = url.pathname.split('/').pop() ?? '';
      const dataset = file.split('.')[0];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(cannedRows(dataset)),
      });
    });
    await page.route(/gbfs\.citibikenyc\.com/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(cannedGbfs()),
      });
    });

    await page.goto('/map');
    await waitForMapReady(page);

    // Scrub to fixture-b. It carries feature_stats.
    await scrubToDate(page, DATE_B);

    // Keep the viewport inside the live area cap and over the grid.
    await jumpTo(page, FIXTURE_GRID_CENTER, 16);
    await waitForRenderedSegments(page);

    await page.click('[data-testid="live-refresh-button"]');

    // Wait for the live hook to report scored results.
    await page.waitForFunction(
      () => {
        const w = window as ExposedWindow;
        const live = w.__robotabilityLiveState;
        return !!live && live.active && live.results.length > 0;
      },
      undefined,
      { timeout: 30_000 }
    );

    // The overlay layer must exist on the map. Before the width
    // expression fix, addLayer threw and the layer never appeared.
    await page.waitForFunction(
      () => {
        const w = window as ExposedWindow;
        const map = w.__robotabilityMap;
        return !!map && !!map.getLayer('live-overlay');
      },
      undefined,
      { timeout: 20_000 }
    );

    // The overlay must carry the scored segments.
    await page.waitForFunction(
      () => {
        const w = window as ExposedWindow;
        const map = w.__robotabilityMap;
        if (!map) return false;
        return map.queryRenderedFeatures({ layers: ['live-overlay'] }).length > 0;
      },
      undefined,
      { timeout: 20_000 }
    );

    // No console error may fire during the whole live refresh.
    expect(consoleErrors).toEqual([]);
  });

  test('(g) a large viewport shows the zoom sentence and sends nothing', async ({
    page,
  }) => {
    const requestUrls: string[] = [];
    page.on('request', (request) => requestUrls.push(request.url()));

    await page.goto('/map');
    await waitForMapReady(page);
    await scrubToDate(page, DATE_B);

    // Zoom far out. The viewport now covers far more than 8 km2.
    await jumpTo(page, FIXTURE_GRID_CENTER, 10);

    const sodaBefore = requestUrls.filter((url) =>
      url.includes('data.cityofnewyork.us')
    ).length;
    await page.click('[data-testid="live-refresh-button"]');

    const banner = page.locator('[data-testid="live-banner"]');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toHaveText(ZOOM_SENTENCE);

    // Zero new requests reached the SODA portal.
    await page.waitForTimeout(500);
    const sodaAfter = requestUrls.filter((url) =>
      url.includes('data.cityofnewyork.us')
    ).length;
    expect(sodaAfter).toBe(sodaBefore);
  });
});
