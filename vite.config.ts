import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  server: {
    hmr: process.env.DISABLE_HMR !== 'true',
  },
  build: {
    sourcemap: false,
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true,
        drop_debugger: false,   // easter egg usa debugger intencionalmente
        passes: 2,
        pure_funcs: ['console.info', 'console.debug'],
      },
      mangle: {
        toplevel: true,
      },
      format: {
        comments: false,
      },
    },
    rollupOptions: {
      output: {
        // Nombres opacos para chunks premium; vendor queda legible (no es secreto)
        chunkFileNames: (info) => {
          const map: Record<string, string> = {
            'academia':   'utils-core',
            'photos':     'assets-loader',
            'AdminPanel': 'admin-panel',
          };
          const name = map[info.name] ?? info.name;
          return `assets/${name}-[hash].js`;
        },
        assetFileNames: 'assets/[hash][extname]',
        manualChunks(id) {
          // Vendor
          if (id.includes('/node_modules/react/') || id.includes('/node_modules/react-dom/') || id.includes('/node_modules/scheduler/')) return 'vendor';
          if (id.includes('/node_modules/motion/') || id.includes('/node_modules/@motionone/')) return 'motion';
          if (id.includes('/node_modules/lucide-react/')) return 'lucide';

          // Academia chunk — todo lo premium en un único fichero opaco
          const acadModules = [
            '/pages/DashboardPage', '/pages/AccountsPage',
            '/pages/InventoryPage', '/pages/OrdersPage',
            '/components/ProfitControl', '/components/TongueEditor',
            '/components/CarpetEditor', '/components/MetadatosEditor',
            '/components/VintedAutoPublish', '/lib/randomExif', '/lib/ep',
          ];
          if (acadModules.some(m => id.includes(m))) return 'academia';

          // Photos chunk
          if (id.includes('/components/ImageUniquifier')) return 'photos';

          // Admin chunk
          if (id.includes('/components/AdminPanel')) return 'AdminPanel';
        },
      },
    },
  },
});
