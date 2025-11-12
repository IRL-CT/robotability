import { Resvg, type ResvgRenderOptions } from '@resvg/resvg-js';
import type { APIRoute } from 'astro';
import satori from 'satori';
import { html as toReactElement } from 'satori-html';
import { readFileSync } from 'fs';
import { join } from 'path';

// Load local fonts
const poppinsFont = readFileSync(join(process.cwd(), 'public', 'fonts', 'poppins.ttf'));
const dmSerifFont = readFileSync(join(process.cwd(), 'public', 'fonts', 'dm-serif.ttf'));

const height = 630;
const width = 1200;

export const GET: APIRoute = async () => {
  const link = 'https://robotability.cornell.edu';
  const html = toReactElement(`
  <div style="background: linear-gradient(135deg, #f3f3f3 0%, #FFE1E1 100%); display: flex; flex-direction: column; height: 100%; width: 100%; padding: 4rem;">
    <div style="display: flex; flex-direction: column; justify-content: space-between; height: 100%; width: 100%;">
      <div style="display: flex; flex-direction: column; gap: 1.5rem;">  
        <h1 style="font-family: 'DM Serif Text'; font-size: 64px; font-weight: 700; color: #000000; margin: 0; line-height: 1.1;">The Robotability Score</h1>
        <p style="font-family: 'DM Serif Text'; font-size: 36px; color: #333333; margin: 0; line-height: 1.4;">Enabling Harmonious Robot Navigation on Urban Streets</p>
        <p style="font-family: 'Poppins'; font-size: 28px; color: #666666; margin: 0; margin-top: 0.5rem;">A novel metric for quantifying urban robot navigation suitability</p>
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 2rem; padding-top: 2rem; border-top: 2px solid rgba(0, 0, 0, 0.1);">
        <p style="font-family: 'Poppins'; font-size: 24px; color: #000000; margin: 0; font-weight: 600;">Made @ Cornell Tech</p>
        <p style="font-family: 'Poppins'; font-size: 20px; color: #666666; margin: 0;">${link}</p>
      </div>
    </div>
  </div>
  `);

  const svg = await satori(html, {
    fonts: [
      {
        name: 'DM Serif Text',
        data: dmSerifFont,
        style: 'normal',
        weight: 700,
      },
      {
        name: 'Poppins',
        data: poppinsFont,
        style: 'normal',
        weight: 400,
      },
    ],
    height,
    width,
  });

  const opts: ResvgRenderOptions = {
    fitTo: {
      mode: 'width',
      value: width,
    },
  };
  const resvg = new Resvg(svg, opts);
  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();

  return new Response(pngBuffer, {
    headers: {
      'content-type': 'image/png',
    },
  });
};
