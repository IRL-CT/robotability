import { test, expect } from '@playwright/test';

// Capture full-page screenshots of the home page in both themes.
// toggle-theme.js follows the system preference, so the tests set the
// emulated colorScheme.
test.describe('home page screenshots', () => {
  test('light theme screenshot', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.screenshot({
      path: '.omo/evidence/task-2/home-light.png',
      fullPage: true,
    });
  });

  test.describe('dark scheme', () => {
    test.use({ colorScheme: 'dark' });

    test('dark theme screenshot', async ({ page }) => {
      await page.goto('/');
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.screenshot({
        path: '.omo/evidence/task-2/home-dark.png',
        fullPage: true,
      });
    });
  });
});
