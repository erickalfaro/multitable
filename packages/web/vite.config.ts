import { defineConfig } from 'vite';
// SWC transforms 5-10x faster than the Babel-based plugin-react. Cold-cache
// import resolution for this project went from ~16s to <1s after switching.
import react from '@vitejs/plugin-react-swc';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    allowedHosts: ['.ts.net'],
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
    // Pre-transform the entry point and its biggest subtrees at server start.
    // Vite walks them once instead of waiting for the browser to request them
    // one-by-one on first load.
    warmup: {
      clientFiles: [
        './src/main.tsx',
        './src/App.tsx',
        './src/components/main-pane/MainPane.tsx',
        './src/components/sidebar/Sidebar.tsx',
      ],
    },
  },
  // Pre-bundle these deps at startup rather than discovering them lazily on
  // first request. Without this, Vite stalls the first page load while it
  // crawls and esbuild-bundles each missing dep.
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react-hot-toast',
      'lucide-react',
      'zustand',
      'react-markdown',
      'streamdown',
    ],
  },
  build: {
    outDir: '../daemon/dist/public',
    emptyOutDir: true,
  },
});
