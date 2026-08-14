/*
 * Theme toggle script.
 * The theme follows the system preference. There is no manual toggle yet.
 * The script sets the data-theme attribute on the html element.
 * It runs before first paint to avoid a flash of the wrong theme.
 * Ported from the personal-site reference
 * (personal_site_for_design_inspo/public/toggle-theme.js).
 */

function getSystemTheme() {
  const supportsMatchMedia =
    typeof window.matchMedia === "function" &&
    typeof window.matchMedia("(prefers-color-scheme: dark)").matches === "boolean";

  // Default to light if system preference isn't available.
  if (!supportsMatchMedia) return "light";

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(themeValue) {
  document.firstElementChild?.setAttribute("data-theme", themeValue);

  const body = document.body;
  if (!body) return;

  const bgColor = window.getComputedStyle(body).backgroundColor;
  document
    .querySelector("meta[name='theme-color']")
    ?.setAttribute("content", bgColor);
}

function syncThemeToSystem() {
  applyTheme(getSystemTheme());
}

// Set early so styles load in the correct theme.
syncThemeToSystem();

window.addEventListener("load", () => {
  syncThemeToSystem();
  document.addEventListener("astro:after-swap", syncThemeToSystem);
});

if (typeof window.matchMedia === "function") {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", syncThemeToSystem);
}
