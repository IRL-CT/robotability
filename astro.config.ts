import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  site: 'https://robotability.cornell.edu',
  base: '',
  trailingSlash: 'ignore',
  integrations: [sitemap(), react()],
  vite: {
    plugins: [tailwindcss()],
    ssr: {
      noExternal: ['maplibre-gl', '@deck.gl/core', '@deck.gl/layers', '@deck.gl/mapbox']
    },
    optimizeDeps: {
      include: ['maplibre-gl', '@deck.gl/core', '@deck.gl/layers', '@deck.gl/mapbox'],
    },
    build: {
      commonjsOptions: {
        include: [/node_modules/]
      }
    }
  },
});