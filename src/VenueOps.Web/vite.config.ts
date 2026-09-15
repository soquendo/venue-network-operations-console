import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ command, isPreview }) => ({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      ...(command === 'serve' && !isPreview ? { '^/simulation(?:/|$)': 'http://127.0.0.1:8081' } : {}),
    },
  },
}))
