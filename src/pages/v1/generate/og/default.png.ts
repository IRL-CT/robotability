// The default Open Graph image for every page that sets no image of its own.
// BaseHead.astro points og:image and twitter:image here.
import type { APIRoute } from 'astro';
import { renderOgCard } from '../../../../lib/og/card';

export const GET: APIRoute = async () => {
  const png = await renderOgCard({
    eyebrow: "ACM CHI '25",
    title: 'The Robotability Score',
    subtitle: 'Enabling Harmonious Robot Navigation on Urban Streets',
  });

  return new Response(new Uint8Array(png), {
    headers: {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=86400',
    },
  });
};
