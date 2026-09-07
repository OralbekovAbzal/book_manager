import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Порт 3001 на машине разработчика может держать установленная программа —
// тогда dev-сервер поднимают на другом порту и указывают его здесь:
// API_TARGET=http://localhost:3011
const API_TARGET = process.env.API_TARGET || 'http://localhost:3001'

export default defineConfig({
  plugins: [react()],
  // Относительные пути к ассетам — чтобы index.html работал под file://
  // (упакованный Electron грузит дист напрямую с диска, без http-сервера).
  base: './',
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/socket.io': { target: API_TARGET, ws: true },
    },
  },
})
