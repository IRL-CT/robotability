import { test, expect } from '@playwright/test';

// Assert the design tokens and the layout components on the home page.
test.describe('design tokens and layout components', () => {
  test('body background follows the light and dark tokens; nav and footer render', async ({
    page,
  }) => {
    await page.goto('/');

    // Light theme. The body background must equal the light fill token.
    const lightBg = await page.evaluate(() =>
      window.getComputedStyle(document.body).backgroundColor.replace(/\s+/g, ' ')
    );
    expect(lightBg).toBe('rgb(251, 254, 251)');

    // Switch to the dark theme.
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });
    // The theme transition takes 0.3s. Wait for it to end.
    await page.waitForTimeout(500);

    // Dark theme. The body background must equal the dark fill token.
    const darkBg = await page.evaluate(() =>
      window.getComputedStyle(document.body).backgroundColor.replace(/\s+/g, ' ')
    );
    expect(darkBg).toBe('rgb(33, 39, 55)');

    // SiteNav and SiteFooter must render on the home page.
    await expect(page.getByTestId('site-nav')).toBeVisible();
    await expect(page.getByTestId('site-footer')).toBeVisible();
  });
});
