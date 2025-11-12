import { Resvg, type ResvgRenderOptions } from '@resvg/resvg-js';
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import satori from 'satori';
import { html as toReactElement } from 'satori-html';
import { readFileSync } from 'fs';
import { join } from 'path';

// Load local fonts
const poppinsFont = readFileSync(join(process.cwd(), 'public', 'fonts', 'poppins.ttf'));
const dmSerifFont = readFileSync(join(process.cwd(), 'public', 'fonts', 'dm-serif.ttf'));

const height = 630;
const width = 1200;

const posts = await getCollection('blog');

export function getStaticPaths() {
  return posts.map((post) => ({
    params: { slug: post.id },
    props: { title: post.data.title, description: post.data.description },
  }));
}

export const GET: APIRoute = async ({ params, props }) => {
  const link = 'https://robotability.cornell.edu';
  const title = props?.title || 'The Robotability Score';
  const description = props?.description || 'A novel metric for quantifying urban robot navigation suitability';
  
  // Escape HTML entities for safety
  const escapeHtml = (text: string) => {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  };

  const html = toReactElement(`
  <div style="background: linear-gradient(135deg, #f3f3f3 0%, #FFE1E1 100%); display: flex; flex-direction: column; height: 100%; width: 100%; padding: 4rem;">
    <div style="display: flex; flex-direction: column; justify-content: space-between; height: 100%; width: 100%;">
      <div style="display: flex; flex-direction: column; gap: 1.5rem;">  
        <h1 style="font-family: 'DM Serif Text'; font-size: 56px; font-weight: 700; color: #000000; margin: 0; line-height: 1.1;">${escapeHtml(title)}</h1>
        <p style="font-family: 'Poppins'; font-size: 32px; color: #333333; margin: 0; line-height: 1.4;">${escapeHtml(description)}</p>
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 2rem; padding-top: 2rem; border-top: 2px solid rgba(0, 0, 0, 0.1);">
        <p style="font-family: 'DM Serif Text'; font-size: 24px; color: #000000; margin: 0; font-weight: 600;">The Robotability Score</p>
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
