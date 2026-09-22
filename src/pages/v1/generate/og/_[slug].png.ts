// The per-post Open Graph image for the blog.
// The route is disabled. The leading underscore keeps Astro from building
// it. Keep it in step with default.png.ts, so a rebuilt blog matches.
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { renderOgCard } from '../../../../lib/og/card';

const posts = await getCollection('blog');

export function getStaticPaths() {
  return posts.map((post) => ({
    params: { slug: post.id },
    props: { title: post.data.title, description: post.data.description },
  }));
}

export const GET: APIRoute = async ({ props }) => {
  const png = await renderOgCard({
    eyebrow: 'The Robotability Score',
    title: props?.title || 'The Robotability Score',
    subtitle:
      props?.description ||
      'A novel metric for quantifying urban robot navigation suitability',
    showStats: false,
  });

  return new Response(new Uint8Array(png), {
    headers: {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=86400',
    },
  });
};
