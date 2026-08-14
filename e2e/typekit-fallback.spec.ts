import { test, expect } from '@playwright/test';

// Block the TypeKit domain. The page must still render text with the
// fallback font stack. The 3-second load check must fire one console warning.
test.describe('TypeKit failure fallback', () => {
  test('text renders and one console warning fires when the kit is blocked', async ({
    page,
  }) => {
    const warnings: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'warning') warnings.push(msg.text());
    });

    // Abort every request to the TypeKit domain.
    await page.route(/use\.typekit\.net/, (route) => route.abort());

    await page.goto('/');

    // The page text must render.
    await expect(page.locator('body')).toContainText('Robotability');

    // The kit must not register any font face.
    const kitFontRegistered = await page.evaluate(() => {
      let found = false;
      document.fonts.forEach((face) => {
        if (/parabolica/i.test(face.family)) found = true;
      });
      return found;
    });
    expect(kitFontRegistered).toBe(false);

    // Wait for the 3-second load check to run.
    await page.waitForTimeout(3_500);

    // Exactly the fallback warning must appear.
    const kitWarnings = warnings.filter((w) => w.includes('krx4hav'));
    expect(kitWarnings.length).toBe(1);
  });
});
