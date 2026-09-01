import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 重型查看器/编辑器依赖单独切 chunk:主包保持轻量,首屏不为 pdf/表格/编辑器买单,
// 且这些 chunk 只有在用户真正打开对应类型文件时才会被请求。
const HEAVY_CHUNKS: Record<string, string[]> = {
  xlsx: ['xlsx'],
  codemirror: ['codemirror', '@codemirror', '@lezer', '@replit', 'style-mod', 'w3c-keyname', 'crelt'],
  pdfjs: ['pdfjs-dist'],
  docx: ['docx-preview'],
  markdown: ['markdown-it'],
  epub: ['epubjs'],
  imageEditor: ['react-filerobot-image-editor'],
  libarchive: ['libarchive.js'],
}

function manualChunks(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined
  const p = id.replace(/\\/g, '/')
  for (const [name, pkgs] of Object.entries(HEAVY_CHUNKS)) {
    for (const pkg of pkgs) {
      if (p.includes(`/node_modules/${pkg}/`) || p.includes(`/node_modules/${pkg.replace('/', '+')}/`)) return name
    }
  }
  return undefined
}

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  // 图片解码 worker 内部有动态 import(utif/ag-psd),必须用 ES 格式才能参与 code-splitting
  worker: {
    format: 'es',
  },
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
})
