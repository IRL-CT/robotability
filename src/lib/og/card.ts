// Shared renderer for the Open Graph preview cards.
// Every og endpoint calls renderOgCard. Keep one design here.
//
// The card follows the site design tokens in src/styles/tokens.css. It uses
// the light theme, because social clients show previews on light chrome.
// The colours below are the literal token values:
//   fill   rgb(251, 254, 251)
//   text   rgb(40, 39, 40)
//   accent rgb(0, 108, 172)
//   border rgb(236, 233, 233)
// The top rule repeats the map score ramp from
// src/components/map/constants.ts. Do not change a colour here without a
// matching change there.
//
// Satori limits. Keep these rules, or the layout breaks:
// - Satori reads an unitless line-height as pixels. Do not set line-height.
// - satori-html does not decode HTML entities. Write the literal character.
// - A stacked child must set flex-shrink: 0, or it collapses.
import { Resvg, type ResvgRenderOptions } from '@resvg/resvg-js';
import satori from 'satori';
import { html as toReactElement } from 'satori-html';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCORE_COLORS } from '../../components/map/constants';
import features from '../../data/features.json';
import indicators from '../../data/indicators.json';

// The card size. Both values are the Open Graph standard.
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

// The site URL. It matches `site` in astro.config.ts.
const SITE_LABEL = 'robotability.cornell.edu';

// The lab credit. The lab is the Interaction Research Lab at Cornell Tech.
const LAB_LABEL = 'Interaction Research Lab · Cornell Tech';

// The design token colours, as CSS strings.
const INK = 'rgb(40, 39, 40)';
const INK_MUTED = 'rgba(40, 39, 40, 0.72)';
const INK_FAINT = 'rgba(40, 39, 40, 0.55)';
const ACCENT = 'rgb(0, 108, 172)';
const LINE = 'rgb(236, 233, 233)';

// Outfit stands in for parabolica, the TypeKit display family. TypeKit
// fonts are not readable at build time. Outfit is the closest local
// geometric sans. Poppins carries the small labels. Both files hold only a
// regular weight, so the card builds hierarchy from size and colour.
const outfitFont = readFileSync(
  join(process.cwd(), 'public', 'fonts', 'outfit.ttf')
);
const poppinsFont = readFileSync(
  join(process.cwd(), 'public', 'fonts', 'poppins.ttf')
);

// The 11 ramp stops as one flex row. Each stop takes an equal share.
const rampBar = SCORE_COLORS.map(
  ([r, g, b]) =>
    `<div style="display: flex; flex-grow: 1; background: rgb(${r}, ${g}, ${b});"></div>`
).join('');

// The three headline numbers. The counts come from the data files, so the
// card stays true after a data change. Do not hardcode a count.
const STATS: ReadonlyArray<{ value: string; label: string }> = [
  { value: String(indicators.length), label: 'built-environment indicators' },
  { value: String(features.length), label: 'survey-weighted key features' },
  { value: 'NYC', label: 'every street, citywide' },
];

// One divider sits before every stat but the first.
const statRow = STATS.map(
  (stat, index) => `
    <div style="display: flex; align-items: center;">
      ${
        index === 0
          ? ''
          : `<div style="display: flex; width: 1px; height: 54px; background: ${LINE}; margin-left: 44px; margin-right: 44px;"></div>`
      }
      <div style="display: flex; flex-direction: column;">
        <div style="display: flex; font-family: 'Outfit'; font-size: 52px; color: ${ACCENT}; letter-spacing: -1px;">${stat.value}</div>
        <div style="display: flex; font-family: 'Poppins'; font-size: 19px; color: ${INK_FAINT}; margin-top: 6px;">${stat.label}</div>
      </div>
    </div>`
).join('');

// Make caller text safe for the markup string. Angle brackets would open a
// tag. Entities do not decode, so every other character stays literal.
function sanitize(text: string): string {
  return text.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
}

export interface OgCardContent {
  // The small label above the title. Use it for the venue or the section.
  eyebrow: string;
  // The headline. Keep it short. A long title steps the type size down.
  title: string;
  // The one-line summary below the title.
  subtitle: string;
  // Set false to drop the stat row. A blog card carries no project stats.
  showStats?: boolean;
}

// Render one card to a PNG buffer.
export async function renderOgCard(content: OgCardContent): Promise<Buffer> {
  const eyebrow = sanitize(content.eyebrow).toUpperCase();
  const title = sanitize(content.title);
  const subtitle = sanitize(content.subtitle);
  const showStats = content.showStats !== false;

  // A long title must not push the footer off the card. Step the size down
  // past the length that fills one line at the larger size.
  const titleSize = title.length > 46 ? 58 : title.length > 30 ? 70 : 82;

  const statBlock = showStats
    ? `<div style="display: flex; flex-shrink: 0; align-items: center;">${statRow}</div>`
    : '';

  const markup = toReactElement(`
  <div style="display: flex; flex-direction: column; width: 100%; height: 100%; background: linear-gradient(135deg, rgb(251, 254, 251) 0%, rgb(238, 244, 243) 100%);">
    <div style="display: flex; width: 100%; height: 12px; flex-shrink: 0;">${rampBar}</div>
    <div style="display: flex; flex-direction: column; justify-content: space-between; flex-grow: 1; padding: 60px 72px 52px 72px;">
      <div style="display: flex; flex-direction: column; flex-shrink: 0;">
        <div style="display: flex; align-items: center; flex-shrink: 0; margin-bottom: 28px;">
          <div style="display: flex; width: 14px; height: 14px; background: ${ACCENT}; margin-right: 14px;"></div>
          <div style="display: flex; font-family: 'Poppins'; font-size: 21px; color: ${ACCENT}; letter-spacing: 3px;">${eyebrow}</div>
        </div>
        <div style="display: flex; flex-shrink: 0; font-family: 'Outfit'; font-size: ${titleSize}px; color: ${INK}; letter-spacing: -1.5px;">${title}</div>
        <div style="display: flex; flex-shrink: 0; font-family: 'Outfit'; font-size: 34px; color: ${INK_MUTED}; margin-top: 18px;">${subtitle}</div>
      </div>
      <div style="display: flex; flex-direction: column; flex-shrink: 0;">
        ${statBlock}
        <div style="display: flex; width: 100%; height: 1px; flex-shrink: 0; background: ${LINE}; margin-top: 40px; margin-bottom: 26px;"></div>
        <div style="display: flex; flex-shrink: 0; align-items: center; justify-content: space-between;">
          <div style="display: flex; font-family: 'Poppins'; font-size: 22px; color: ${INK};">${LAB_LABEL}</div>
          <div style="display: flex; font-family: 'Poppins'; font-size: 22px; color: ${ACCENT};">${SITE_LABEL}</div>
        </div>
      </div>
    </div>
  </div>
  `);

  const svg = await satori(markup, {
    fonts: [
      { name: 'Outfit', data: outfitFont, style: 'normal', weight: 400 },
      { name: 'Poppins', data: poppinsFont, style: 'normal', weight: 400 },
    ],
    height: OG_HEIGHT,
    width: OG_WIDTH,
  });

  const opts: ResvgRenderOptions = {
    fitTo: { mode: 'width', value: OG_WIDTH },
  };

  return new Resvg(svg, opts).render().asPng();
}
