import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

// GitHub Pages serves a project site from /<repo>/, so assets, the manifest
// and the service worker scope all need that prefix. Local dev stays at /.
const base = process.env.BASE_PATH || '/'

export default defineConfig({
  base,
  define: {
    // Shown at the foot of the planner, so an installed PWA can be checked
    // against the latest deploy at a glance.
    __BUILD__: JSON.stringify(
      new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
    ),
  },
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
  },
  preview: {
    allowedHosts: ['.trycloudflare.com'],
  },
  build: {
    rollupOptions: {
      output: {
        // Rolldown (Vite 8) only takes the function form.
        manualChunks: (id) => (id.includes('maplibre-gl') ? 'maplibre' : undefined),
      },
    },
  },
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Meguri — round-trip route maker',
        short_name: 'Meguri',
        id: base,
        scope: base,
        start_url: base,
        description: 'Create beautiful walking and cycling loops of exactly the length you want.',
        theme_color: '#0c111b',
        background_color: '#0c111b',
        display: 'standalone',
        orientation: 'portrait-primary',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [
          {
            // OpenFreeMap style, glyphs, sprites and vector tiles
            urlPattern: /^https:\/\/tiles\.openfreemap\.org\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: { maxEntries: 600, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // Outfit is served from our own origin now, so it is precached by
          // globPatterns above rather than cached at runtime off Google's CDN.
        ],
      },
    }),
  ],
})
