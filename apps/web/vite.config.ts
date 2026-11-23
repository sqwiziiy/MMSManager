import react from '@vitejs/plugin-react'
import process from 'node:process'
import { defineConfig } from 'vitest/config'

const webPort = Number(process.env['MMSMANAGER_WEB_PORT'] || 5173)
const apiPort = Number(process.env['MMSMANAGER_API_PORT'] || 4174)

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: false,
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
