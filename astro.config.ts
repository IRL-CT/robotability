import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://robotability.cornell.edu',
  base: '',
  trailingSlash: 'ignore',
  integrations: [sitemap(), react()],
  vite: {
    plugins: [tailwindcss()],
    ssr: {
      noExternal: ['maplibre-gl'],
      external: ['@deck.gl/core', '@deck.gl/layers', '@deck.gl/mapbox', '@luma.gl/core', '@luma.gl/shadertools', '@luma.gl/constants', '@luma.gl/engine', '@luma.gl/webgl']
    },
    optimizeDeps: {
      include: ['maplibre-gl', '@deck.gl/core', '@deck.gl/layers', '@deck.gl/mapbox', '@luma.gl/core', '@luma.gl/shadertools'],
    },
    build: {
      commonjsOptions: {
        include: [/node_modules/]
      }
    }
  },
});
