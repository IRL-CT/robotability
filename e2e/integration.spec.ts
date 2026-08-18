import { expect, test } from '@playwright/test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// T14 spec. The end-to-end journey across the whole site.
// home -> nav -> /map -> scrubber across two fixture snapshots ->
// breakdown panel on both fixtures and the 2023 baseline -> mocked
// live refresh -> dark mode toggle mid-session -> mobile viewport.

// ESM has no __dirname. Derive this file's directory from import.meta.url.
const specDir = path.dirname(fileURLToPath(import.meta.url));

// The fixture dates. fixture-a and fixture-b share one bbox, so both
// cover the same 144 segment ids.
const DATE_A = '2026-01-01'; // fixture-a
const DATE_B = '2026-02-01'; // fixture-b
const DATE_BASELINE = '2023-08-01';

// The fixture grids. The T5 mock pipeline places a 12x12 grid at the
// bbox corner. Fixture bbox: -73.895,40.733,-73.880,40.745.
const FIXTURE_BBOX = { minLon: -73.895, minLat: 40.733, maxLon: -73.88, maxLat: 40.745 };
const FIXTURE_GRID_CENTER: [number, number] = [-73.89428, 40.7339];

// Exact UI sentences. The components must emit them byte for byte.
const FALLBACK_SENTENCE =
  'Feature-level data is unavailable for the 2023 baseline. Only the aggregate score exists.';
const DISABLED_SENTENCE = 'Live refresh is unavailable. Showing the latest snapshot.';

// The SODA token of the test process. The live refresh test branches on
// it. A set token runs the mocked happy path. An unset token runs the
// degraded path: the quota guard blocks the refresh and the page shows
// the exact disabled sentence.
const SODA_TOKEN = process.env.PUBLIC_SODA_TOKEN ?? '';
const HAS_TOKEN = SODA_TOKEN.trim().length > 0;

// Structural types for the window hooks. They avoid any use of `as any`.
type RenderedFeature = {
  properties?: { id?: unknown; score?: unknown };
  geometry: { type: string; coordinates: Array<[number, number]> };
};

type ExposedMap = {
  getLayer(id: string): unknown;
  getLayoutProperty(layerId: string, name: string): unknown;
  setLayoutProperty(layerId: string, name: string, value: unknown): void;
  isStyleLoaded(): boolean;
  loaded(): boolean;
  queryRenderedFeatures(options: { layers: string[] }): RenderedFeature[];
  project(lngLat: [number, number]): { x: number; y: number };
  getCenter(): { lng: number; lat: number };
  getZoom(): number;
  jumpTo(options: { center: [number, number]; zoom: number; pitch: number }): void;
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
  | '__robotabilityTimeState'
  | '__robotabilityLiveState'
> & {
  __robotabilityMap?: ExposedMap;
  __robotabilityMapStyleUrl?: string;
  __robotabilityTimeState?: TimeHook;
  __robotabilityLiveState?: LiveHook;
};

type SegmentTarget = { id: number; score: number; x: number; y: number };

// ---------------------------------------------------------------------
// dist patching. The spec copies both fixtures into dist/ and appends
// their manifest entries to dist/manifest.json. afterAll restores the
// original manifest bytes and removes both fixture dirs. The restore is
// verified with a sha256 comparison.
// ---------------------------------------------------------------------

const distDir = path.join(specDir, '..', 'dist');
const distManifestPath = path.join(distDir, 'manifest.json');
let originalManifest: Buffer | null = null;
let manifestShaBefore = '';

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function patchDist(): void {
  originalManifest = fs.readFileSync(distManifestPath);
  manifestShaBefore = sha256(originalManifest);
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
  // Verify the byte-exact restore. The sha must match the pre-patch value.
  const restored = fs.readFileSync(distManifestPath);
  expect(sha256(restored)).toBe(manifestShaBefore);
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

async function waitForMapIdle(
  page: import('@playwright/test').Page,
  timeout = 15_000
): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = window as ExposedWindow;
      return !!w.__robotabilityMap && w.__robotabilityMap.loaded();
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
  await waitForMapIdle(page);
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
  await waitForMapIdle(page);
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

// Click one rendered segment and wait for the breakdown panel.
async function clickFirstSegment(page: import('@playwright/test').Page): Promise<SegmentTarget> {
  // The pick can land in a short styledata window: isStyleLoaded is
  // false for a moment while the features are already rendered. Retry
  // the pick until the window closes, like the other waits in this spec.
  let target: SegmentTarget | null = null;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    target = await page.evaluate(pickSegmentTarget);
    if (target) break;
    await page.waitForTimeout(250);
  }
  expect(target).not.toBeNull();
  if (!target) throw new Error('No rendered segment was found.');
  await clickAt(page, target.x, target.y);
  await expect(page.locator('[data-testid="breakdown-panel"]')).toBeVisible({
    timeout: 10_000,
  });
  return target;
}

// ---------------------------------------------------------------------
// Mocked SODA data for the live refresh. The canned rows sit on the
// fixture grid midpoints, so the nearest-anchor assignment hits every
// segment. The values differ from the fixture snapshot values, so the
// live scores must move.
// ---------------------------------------------------------------------

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

// Canned SODA rows for one dataset. The shapes mirror the mocks in
// e2e/time-live.spec.ts so both specs exercise the same mapping code.
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

// Read one design token from the html element. The tokens are RGB
// triplets like "251, 254, 251".
async function readToken(page: import('@playwright/test').Page, name: string): Promise<string> {
  return page.evaluate((tokenName) => {
    return window
      .getComputedStyle(document.documentElement)
      .getPropertyValue(tokenName)
      .trim();
  }, name);
}

// ---------------------------------------------------------------------
// Tests. Playwright runs the tests of one file in order. Each test gets
// a fresh page. The dist patch lives for the whole file.
// ---------------------------------------------------------------------

test.describe('end-to-end journey', () => {
  test('(1) home page loads and the nav carries the user to /map', async ({
    page,
  }) => {
    await page.goto('/');

    // The home page renders the hero and the site nav.
    await expect(page.getByTestId('site-nav')).toBeVisible();
    await expect(page.locator('main h1').first()).toBeVisible();

    // The nav lists the four site links. The blog is disabled, so it
    // carries no nav entry.
    const nav = page.getByTestId('site-nav');
    await expect(nav.getByRole('link', { name: 'Map', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Methodology', exact: true })).toBeVisible();

    // Click the Map link. The router moves to /map and the map mounts.
    await nav.getByRole('link', { name: 'Map', exact: true }).click();
    await page.waitForURL('**/map', { timeout: 30_000 });
    await waitForMapReady(page);

    // The newest fixture auto-loads on the patched manifest.
    expect(await activeDate(page)).toBe(DATE_B);
  });

  test('(2) the scrubber walks the baseline and both fixture snapshots', async ({
    page,
  }) => {
    await page.goto('/map');
    await waitForMapReady(page);
    await jumpTo(page, FIXTURE_GRID_CENTER, 17.5);
    await waitForRenderedSegments(page);

    // The scrubber lists all three manifest entries in date order.
    const dates = await page.evaluate(() => {
      const w = window as ExposedWindow;
      return w.__robotabilityTimeState?.dates ?? [];
    });
    expect(dates).toEqual([DATE_BASELINE, DATE_A, DATE_B]);

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
    let changed = 0;
    for (const entry of scoresA) {
      const before = byIdB.get(entry.id);
      if (before === undefined) continue;
      if (Math.abs(before - entry.score) > 1e-6) changed += 1;
    }
    expect(changed).toBeGreaterThan(0);
    expect(await activeDate(page)).toBe(DATE_A);

    // Scrub to the 2023 baseline. The active date follows.
    await scrubToDate(page, DATE_BASELINE);
    expect(await activeDate(page)).toBe(DATE_BASELINE);

    // Scrub back to fixture-b. The walk ends where it started.
    await scrubToDate(page, DATE_B);
    expect(await activeDate(page)).toBe(DATE_B);
  });

  test('(3) the breakdown panel works on both fixtures and the baseline', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(String(error)));

    await page.goto('/map');
    await waitForMapReady(page);

    // --- fixture-a: a real breakdown with 19 rows. ---
    await scrubToDate(page, DATE_A);
    await jumpTo(page, FIXTURE_GRID_CENTER, 17.5);
    await waitForRenderedSegments(page);
    const targetA = await clickFirstSegment(page);
    const rowsA = page.locator('[data-testid="breakdown-row"]');
    await expect(rowsA).toHaveCount(19, { timeout: 15_000 });
    const bodyA = await page.locator('[data-testid="breakdown-body"]').innerText();
    expect(bodyA).not.toContain('NaN');
    const totalA = Number.parseFloat(
      await page.locator('[data-testid="breakdown-total"]').innerText()
    );
    expect(Number.isFinite(totalA)).toBe(true);
    expect(Math.abs(totalA - targetA.score)).toBeLessThan(0.001);
    await page.click('[data-testid="breakdown-close"]');
    await expect(page.locator('[data-testid="breakdown-panel"]')).toHaveCount(0);

    // --- fixture-b: a real breakdown with 19 rows. ---
    await scrubToDate(page, DATE_B);
    await jumpTo(page, FIXTURE_GRID_CENTER, 17.5);
    await waitForRenderedSegments(page);
    const targetB = await clickFirstSegment(page);
    const rowsB = page.locator('[data-testid="breakdown-row"]');
    await expect(rowsB).toHaveCount(19, { timeout: 15_000 });
    const totalB = Number.parseFloat(
      await page.locator('[data-testid="breakdown-total"]').innerText()
    );
    expect(Number.isFinite(totalB)).toBe(true);
    expect(Math.abs(totalB - targetB.score)).toBeLessThan(0.001);
    await page.click('[data-testid="breakdown-close"]');
    await expect(page.locator('[data-testid="breakdown-panel"]')).toHaveCount(0);

    // --- baseline: the exact fallback sentence, byte for byte. ---
    await scrubToDate(page, DATE_BASELINE);
    // The baseline covers all of NYC. Use the default initial view.
    await jumpTo(page, [-73.9712, 40.7831], 12);
    await waitForRenderedSegments(page);
    await clickFirstSegment(page);
    const body = page.locator('[data-testid="breakdown-body"]');
    await expect(body).toHaveText(FALLBACK_SENTENCE, { timeout: 10_000 });
    const text = await body.textContent();
    expect(text).toBe(FALLBACK_SENTENCE);

    // The journey logged no console errors.
    expect(errors).toEqual([]);
  });

  test('(4) live refresh: mocked flow with a token, disabled flow without', async ({
    page,
  }) => {
    const sodaUrls: string[] = [];

    if (HAS_TOKEN) {
      // Token set. Mock the SODA portal and the GBFS feed. The refresh
      // must score the viewport segments and label them approximate.
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

      // The result banner lists the biggest movers.
      const resultList = page.locator('[data-testid="live-delta-list"]');
      await expect(resultList).toBeVisible({ timeout: 10_000 });
      expect(await page.locator('[data-testid="live-delta-row"]').count()).toBeGreaterThan(0);

      // The live hook reports scored segments and at least one moved score.
      const live = await page.evaluate(() => {
        const w = window as ExposedWindow;
        return w.__robotabilityLiveState ?? null;
      });
      expect(live).not.toBeNull();
      expect(live?.active).toBe(true);
      const moved = (live?.results ?? []).some(
        (entry) => entry.status === 'scored' && Math.abs(entry.delta) > 1e-4
      );
      expect(moved).toBe(true);
      expect(sodaUrls.length).toBeGreaterThan(0);
    } else {
      // Token unset. The refresh must degrade to the disabled sentence.
      // The spec seeds the quota guard's disabled flag. The guard then
      // blocks the run before any request leaves the page.
      await page.goto('/map');
      await waitForMapReady(page);
      await scrubToDate(page, DATE_B);
      await jumpTo(page, FIXTURE_GRID_CENTER, 16);
      await waitForRenderedSegments(page);

      await page.evaluate(() => {
        const fifteenMinutes = 15 * 60 * 1000;
        localStorage.setItem(
          'robotability.soda.disabledUntil',
          String(Date.now() + fifteenMinutes)
        );
      });

      await page.click('[data-testid="live-refresh-button"]');

      // The banner shows the exact disabled sentence.
      const banner = page.locator('[data-testid="live-banner"]');
      await expect(banner).toBeVisible({ timeout: 30_000 });
      await expect(banner).toHaveText(DISABLED_SENTENCE);

      // No SODA request left the page.
      expect(sodaUrls.length).toBe(0);
    }
  });

  test('(5) a dark mode toggle mid-session keeps the map and panels usable', async ({
    page,
  }) => {
    await page.goto('/map');
    await waitForMapReady(page);
    await waitForMapIdle(page);

    // Light theme first. The basemap and the palette tokens show light.
    const lightStyle = await page.evaluate(() => {
      const w = window as ExposedWindow;
      return w.__robotabilityMapStyleUrl ?? '';
    });
    expect(lightStyle).toContain('positron');
    expect(await readToken(page, '--color-fill')).toBe('251, 254, 251');
    expect(await readToken(page, '--color-accent')).toBe('0, 108, 172');
    const lightBg = await page.evaluate(() =>
      window.getComputedStyle(document.body).backgroundColor.replace(/\s+/g, ' ')
    );
    expect(lightBg).toBe('rgb(251, 254, 251)');

    // Count the rendered segments before the switch.
    await jumpTo(page, FIXTURE_GRID_CENTER, 17.5);
    await waitForRenderedSegments(page);
    const beforeScores = await sampleScores(page);
    expect(beforeScores.length).toBeGreaterThan(0);

    // Toggle the theme mid-session. The MutationObserver reacts.
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });

    // Wait for the dark basemap with the segments layer intact.
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
    await waitForMapIdle(page);

    // The basemap style switched.
    const darkStyle = await page.evaluate(() => {
      const w = window as ExposedWindow;
      return w.__robotabilityMapStyleUrl ?? '';
    });
    expect(darkStyle).toContain('dark-matter');

    // The palette tokens flipped.
    expect(await readToken(page, '--color-fill')).toBe('33, 39, 55');
    expect(await readToken(page, '--color-accent')).toBe('255, 107, 1');
    // The theme transition takes 0.3s. Wait for it to end.
    await page.waitForTimeout(500);
    const darkBg = await page.evaluate(() =>
      window.getComputedStyle(document.body).backgroundColor.replace(/\s+/g, ' ')
    );
    expect(darkBg).toBe('rgb(33, 39, 55)');

    // The map layers survive. The segment count stays the same.
    await waitForRenderedSegments(page);
    const afterScores = await sampleScores(page);
    expect(afterScores.length).toBe(beforeScores.length);

    // The panels stay usable. The time panel and the layer controls render.
    await expect(page.locator('[data-testid="time-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="layer-controls"]')).toBeVisible();
    await expect(page.locator('[data-testid="time-scrubber"]')).toBeEnabled();

    // Toggle a layer off and on. The map obeys the panel after the switch.
    await page.getByLabel('Deployment markers').uncheck();
    await page.waitForFunction(
      () => {
        const w = window as ExposedWindow;
        const map = w.__robotabilityMap;
        if (!map || !map.getLayer('deployments')) return false;
        return map.getLayoutProperty('deployments', 'visibility') === 'none';
      },
      undefined,
      { timeout: 10_000 }
    );
    await page.getByLabel('Deployment markers').check();
    await page.waitForFunction(
      () => {
        const w = window as ExposedWindow;
        const map = w.__robotabilityMap;
        if (!map || !map.getLayer('deployments')) return false;
        return map.getLayoutProperty('deployments', 'visibility') === 'visible';
      },
      undefined,
      { timeout: 10_000 }
    );
  });
});

test.describe('mobile viewport (390px)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the map renders, the panels stay usable, no horizontal scroll', async ({
    page,
  }) => {
    await page.goto('/map');
    await waitForMapReady(page);

    // The page must not scroll horizontally.
    const scroll = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth);

    // The panels render and stay reachable.
    await expect(page.locator('[data-testid="time-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="layer-controls"]')).toBeVisible();

    // The scrubber works at mobile width.
    await scrubToDate(page, DATE_A);
    expect(await activeDate(page)).toBe(DATE_A);

    // The map renders segments and the breakdown opens at mobile width.
    await jumpTo(page, FIXTURE_GRID_CENTER, 17.5);
    await waitForRenderedSegments(page);
    await clickFirstSegment(page);
    const panel = page.locator('[data-testid="breakdown-panel"]');
    await expect(panel).toBeVisible();
    // The panel fits the screen. Its max width is 90vw.
    const panelBox = await panel.boundingBox();
    expect(panelBox).not.toBeNull();
    if (panelBox) {
      expect(panelBox.width).toBeLessThanOrEqual(390);
    }
    await expect(page.locator('[data-testid="breakdown-row"]')).toHaveCount(19, {
      timeout: 15_000,
    });

    // The horizontal scroll check still holds with the panel open.
    const scrollAfter = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollAfter.scrollWidth).toBeLessThanOrEqual(scrollAfter.clientWidth);
  });
});
