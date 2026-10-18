import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 相对路径 base：同一份构建产物可直接部署到 GitHub Pages 子路径或 Vercel 根路径
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5180 },
})
