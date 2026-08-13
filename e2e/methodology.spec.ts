import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// The directory of this spec file. The package is ESM, so __dirname
// does not exist.
const specDir = path.dirname(fileURLToPath(import.meta.url));

// One row of src/data/weights.json.
interface WeightEntry {
  feature: string;
  displayName: string;
  weight: string;
  polarity: 1 | -1;
  sourceType: 'nyc_open_data' | 'external_public' | 'in_house' | 'constant';
  datasetId: string[] | null;
  sourceUrl: string | null;
}

// The nav must show these five items on every default-layout page.
const NAV_ITEMS = [
  { name: 'Map', url: '/map' },
  { name: 'Methodology', url: '/methodology' },
  { name: 'Blog', url: '/blog' },
  { name: 'Paper', url: 'https://doi.org/10.1145/3706598.3714009' },
  { name: 'Code', url: 'https://github.com/FAR-LAB/robotability-nyc' },
];

// NYC OpenData Terms of Use disclaimer for third-party applications.
// The methodology page must print this sentence verbatim.
const TOU_DISCLAIMER =
  'The City of New York can not vouch for the accuracy or completeness of data provided by this web site or application or for the usefulness or integrity of the web site or application. This site provides applications using data that has been modified for use from its original source, NYC.gov, the official web site of the City of New York.';

// Read the weights data. Return null when the file does not exist yet.
function loadWeights(): WeightEntry[] | null {
  const weightsPath = path.join(specDir, '..', 'src', 'data', 'weights.json');
  if (!fs.existsSync(weightsPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(weightsPath, 'utf8')) as WeightEntry[];
}

// Render a weight the same way the page does: percent with two decimals.
function percent(weight: string): string {
  return `${(Number.parseFloat(weight) * 100).toFixed(2)}%`;
}

test.describe('methodology page', () => {
  test('renders the formula section and a 19-row weights table', async ({
    page,
  }) => {
    await page.goto('/methodology');

    // The formula section renders and names the formula terms.
    const formula = page.getByTestId('formula-section');
    await expect(formula).toBeVisible();
    await expect(formula).toContainText('polarity');
    await expect(formula).toContainText('weight');

    // The weights table has exactly 19 body rows.
    const rows = page.getByTestId('weights-table').locator('tbody tr');
    await expect(rows).toHaveCount(19);

    // Spot-check three rows against src/data/weights.json.
    const weights = loadWeights();
    expect(weights, 'src/data/weights.json must exist').not.toBeNull();
    const spotFeatures = [
      'sidewalk_width',
      'pedestrian_density',
      'intersection_safety',
    ];
    for (const feature of spotFeatures) {
      const entry = weights!.find((item) => item.feature === feature);
      expect(entry, `weights.json must list ${feature}`).toBeDefined();
      const row = rows.filter({ hasText: entry!.displayName });
      await expect(row).toContainText(entry!.weight);
      await expect(row).toContainText(percent(entry!.weight));
    }
  });

  test('links every NYC OpenData dataset and prints the ToU disclaimer verbatim', async ({
    page,
  }) => {
    await page.goto('/methodology');

    // Every nyc_open_data row links every dataset id on the canonical
    // dataset page URL.
    const weights = loadWeights();
    expect(weights, 'src/data/weights.json must exist').not.toBeNull();
    const openDataRows = weights!.filter(
      (item) => item.sourceType === 'nyc_open_data'
    );
    expect(openDataRows.length).toBeGreaterThan(0);
    for (const entry of openDataRows) {
      expect(entry.datasetId, `${entry.feature} must list dataset ids`).not.toBeNull();
      for (const id of entry.datasetId!) {
        const link = page.locator(
          `a[href="https://data.cityofnewyork.us/dataset/${id}"]`
        );
        await expect(link, `dataset link for ${id}`).not.toHaveCount(0);
      }
    }

    // The disclaimer sentence appears verbatim.
    const bodyText = await page.locator('body').innerText();
    expect(bodyText).toContain(TOU_DISCLAIMER);
  });
});

test.describe('site navigation', () => {
  test('shows the five nav items on / and /methodology', async ({ page }) => {
    for (const pagePath of ['/', '/methodology']) {
      await page.goto(pagePath);
      const nav = page.getByTestId('site-nav');
      await expect(nav).toBeVisible();
      for (const item of NAV_ITEMS) {
        const link = nav.getByRole('link', { name: item.name, exact: true });
        await expect(link, `nav item ${item.name} on ${pagePath}`).toBeVisible();
        await expect(link).toHaveAttribute('href', item.url);
      }
    }
  });
});

test.describe('404 page', () => {
  test('a bogus URL serves the styled 404 page', async ({ page }) => {
    await page.goto('/no-such-page-t12-probe');

    // The body background matches the light fill token.
    const bg = await page.evaluate(() =>
      window.getComputedStyle(document.body).backgroundColor.replace(/\s+/g, ' ')
    );
    expect(bg).toBe('rgb(251, 254, 251)');

    // The nav stays intact on the 404 page.
    await expect(page.getByTestId('site-nav')).toBeVisible();

    // The page shows the T2 heading and a T2 button.
    await expect(
      page.getByRole('heading', { name: 'Page not found' })
    ).toBeVisible();
    await expect(page.locator('.project-button').first()).toBeVisible();
  });
});
