import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The JSON files are the only source of the feature and indicator lists.
// The test reads them and compares their lengths to the rendered counts.
const features = JSON.parse(
  readFileSync(fileURLToPath(new URL('../src/data/features.json', import.meta.url)), 'utf-8')
) as { name: string; weight: string }[];

const indicators = JSON.parse(
  readFileSync(fileURLToPath(new URL('../src/data/indicators.json', import.meta.url)), 'utf-8')
) as { term: string; description: string }[];

// The exact NYC OpenData Terms of Use disclaimer sentence.
// The footer must carry it verbatim.
const TOU_DISCLAIMER =
  'The City of New York can not vouch for the accuracy or completeness of data provided by this web site or application or for the usefulness or integrity of the web site or application. This site provides applications using data that has been modified for use from its original source, NYC.gov, the official web site of the City of New York.';

// The section headings must appear in this exact order.
const HEADING_SEQUENCE = [
  'The Robotability Score',
  'What is The Robotability Score?',
  'Key Features',
  'Complete Indicator List',
  'Proof-of-Concept Video',
  'Project Team',
  'Paper Citation',
  'Data Attribution',
];

test.describe('home page', () => {
  test('all sections render in order', async ({ page }) => {
    await page.goto('/');

    // Collect every heading text in DOM order.
    const headings = await page
      .locator('main h1, main h2, main h3, footer[data-testid="home-footer"] h2')
      .allTextContents();
    const cleaned = headings.map((h) => h.replace(/\s+/g, ' ').trim());

    // Each expected heading must appear, and the order must hold.
    let cursor = 0;
    for (const expected of HEADING_SEQUENCE) {
      const found = cleaned.indexOf(expected, cursor);
      expect(found, `heading "${expected}" must appear after position ${cursor}`).toBeGreaterThanOrEqual(0);
      cursor = found + 1;
    }

    // The hero CTA buttons must point to the map and the paper DOI.
    await expect(page.locator('main a[href="/map"]').first()).toBeVisible();
    await expect(
      page.locator('main a[href*="10.1145/3706598.3714009"]').first()
    ).toBeVisible();
  });

  test('HoverReveal opens on hover of an indicator term and shows its description', async ({
    page,
  }) => {
    await page.goto('/');

    const glossary = page.getByTestId('indicator-glossary');
    await expect(glossary).toBeVisible();

    // Use the first indicator entry from the JSON as the probe.
    const first = indicators[0];
    const entry = glossary
      .locator('[data-testid="indicator-entry"]', { hasText: first.term })
      .first();
    const word = entry.locator('.hover-reveal__word');
    const card = entry.locator('.hover-reveal__card');

    // The card starts closed (opacity 0).
    await expect(card).toHaveCSS('opacity', '0');

    // Hover the term. The satellite card must open and show the description.
    await word.hover();
    await expect(card).toHaveCSS('opacity', '1');
    await expect(card).toContainText(first.description);
  });

  test('footer carries the NYC OpenData ToU disclaimer verbatim', async ({
    page,
  }) => {
    await page.goto('/');

    const footer = page.getByTestId('home-footer');
    await expect(footer).toBeVisible();
    await expect(footer).toContainText(TOU_DISCLAIMER);
  });

  test('rendered counts match the JSON files exactly (data-driven proof)', async ({
    page,
  }) => {
    await page.goto('/');

    // The JSON files hold the real data. The page must render every entry.
    expect(features.length).toBe(6);
    expect(indicators.length).toBe(24);

    const pillCount = await page.getByTestId('feature-pill').count();
    expect(pillCount).toBe(features.length);

    const indicatorCount = await page.getByTestId('indicator-entry').count();
    expect(indicatorCount).toBe(indicators.length);

    // Spot check: each JSON feature name must render on the page.
    for (const feature of features) {
      await expect(
        page.getByTestId('feature-pill').filter({ hasText: feature.name })
      ).toHaveCount(1);
    }

    // Spot check: each JSON indicator term must render on the page.
    for (const indicator of indicators) {
      await expect(
        page.getByTestId('indicator-entry').filter({ hasText: indicator.term })
      ).not.toHaveCount(0);
    }
  });
});
