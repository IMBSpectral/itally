import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5190,
    strictPort: true,
    // same-origin API calls, so no CORS setup
    proxy: { '/api': 'http://127.0.0.1:4100' },
  },
})
