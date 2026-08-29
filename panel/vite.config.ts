import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // 开发模式：API 走 panel 插件的 HTTP 服务（默认 3111）
      '/api': 'http://127.0.0.1:3111'
    }
  }
})
