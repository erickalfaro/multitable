import { defineConfig } from 'vite';
// SWC transforms 5-10x faster than the Babel-based plugin-react. Cold-cache
// import resolution for this project went from ~16s to <1s after switching.
import react from '@vitejs/plugin-react-swc';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    allowedHosts: ['.ts.net'],
    // On Linux, Node's fs.watch (which chokidar uses) allocates one inotify
    // instance per directory, and `fs.inotify.max_user_instances` is small
    // (often 128). A busy machine — several dev servers, editors, plus the
    // MultiTable daemon — exhausts that budget and Vite crashes at startup with
    // `EMFILE: too many open files`. Polling sidesteps inotify entirely. Default
    // on; opt back into native inotify with MULTITABLE_WATCH_NATIVE=1.
    watch:
      process.env.MULTITABLE_WATCH_NATIVE === '1'
        ? undefined
        : {
            usePolling: true,
            interval: Number(process.env.MULTITABLE_WATCH_INTERVAL) || 1000,
          },
    proxy: {
      // Pin to 127.0.0.1, NOT localhost. The daemon binds IPv4 (host
      // 127.0.0.1), but Node resolves `localhost` to IPv6 `::1` first — so a
      // `localhost` target silently lands on whatever else is squatting on
      // that port (e.g. a Next.js dev server), which 404s every /api call.
      // Port 3117 (not the ubiquitous 3000) also keeps us off the default
      // dev-server collision path. Keep in sync with config/loader.ts default.
      '/api': {
        target: 'http://127.0.0.1:3117',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:3117',
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
      '@iconify/react',
      'zustand',
      'react-markdown',
      'streamdown',
    ],
  },
  build: {
    outDir: '../daemon/dist/public',
    emptyOutDir: true,
    // Offline Iconify collections live in public/iconify/ (~20 MB) and are
    // lazy-fetched per set — don't try to inline them.
  },
});
