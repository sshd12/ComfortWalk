import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],

  server: {
    proxy: {
      '/valhalla': {
        target:
          'https://valhalla1.openstreetmap.de',
        changeOrigin: true,
        rewrite: path =>
          path.replace(
            /^\/valhalla/,
            ''
          )
      },

      '/nominatim': {
        target:
          'https://nominatim.openstreetmap.org',
        changeOrigin: true,
        rewrite: path =>
          path.replace(
            /^\/nominatim/,
            ''
          )
      },

      '/overpass': {
        target:
          'https://overpass-api.de',
        changeOrigin: true,
        rewrite: path =>
          path.replace(
            /^\/overpass/,
            ''
          )
      }
    }
  }
})