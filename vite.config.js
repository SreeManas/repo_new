import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'
import { visualizer } from 'rollup-plugin-visualizer'
import viteCompression from 'vite-plugin-compression'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    // Production build optimizations
    build: {
      outDir: 'dist',
      sourcemap: mode === 'development',
      minify: 'terser',
      terserOptions: {
        compress: {
          drop_console: mode === 'production',
          drop_debugger: mode === 'production',
          pure_funcs: mode === 'production' ? ['console.log', 'console.info'] : []
        }
      },
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ['react', 'react-dom'],
            mapbox: ['mapbox-gl'],
            charts: ['recharts'],
            utils: ['axios', 'localforage'],
            ui: ['lucide-react']
          },
          chunkFileNames: 'assets/[name]-[hash].js',
          entryFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash].[ext]'
        }
      },
      chunkSizeWarningLimit: 1000,
      reportCompressedSize: false
    },


    // Development server configuration
    server: {
      port: 5173,
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
        'Cross-Origin-Embedder-Policy': 'unsafe-none'
      },
      proxy: {
        '/supervity-api': {
          target: 'https://auto-workflow-api.supervity.ai',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/supervity-api/, '')
        }
      }
    },

    // Resolve aliases for cleaner imports
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@components': path.resolve(__dirname, './src/components'),
        '@services': path.resolve(__dirname, './src/services'),
        '@utils': path.resolve(__dirname, './src/utils'),
        '@hooks': path.resolve(__dirname, './src/hooks')
      }
    },

    // Define global constants
    define: {
      __APP_ENV__: JSON.stringify(env.NODE_ENV || 'development')
    },

    // Performance optimizations
    optimizeDeps: {
      include: ['react', 'react-dom', 'mapbox-gl'],
      exclude: ['@vitejs/plugin-react']
    },

    // Plugins
    plugins: [
      react(),

      // ─── Inline plugin: serve /api/* handlers in dev (simulates Vercel serverless) ───
      {
        name: 'api-dev-server',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith('/api/')) return next();

            // 1. Parse JSON body from the raw stream
            if (req.body === undefined) {
              await new Promise((resolve) => {
                let data = '';
                req.on('data', chunk => { data += chunk.toString(); });
                req.on('end', () => {
                  if (data) {
                    try { req.body = JSON.parse(data); }
                    catch { req.body = data; }
                  } else {
                    req.body = {};
                  }
                  resolve();
                });
              });
            }

            // 2. Add Express-style helpers to the plain Node response
            if (!res.status) {
              res.status = function (code) {
                this.statusCode = code;
                return this;
              };
            }
            if (!res.json) {
              res.json = function (data) {
                if (!this.headersSent) {
                  this.setHeader('Content-Type', 'application/json');
                }
                this.end(JSON.stringify(data));
              };
            }
            if (!res.set) {
              res.set = res.setHeader.bind(res);
            }

            try {
              const apiPath = req.url.replace(/\?.*$/, '');
              // Resolve handler: try flat file (api/foo.js) first,
              // then directory index (api/foo/index.js) — matches Vercel convention
              const flatPath  = path.join(__dirname, apiPath + '.js');
              const indexPath = path.join(__dirname, apiPath, 'index.js');
              const handlerPath = fs.existsSync(flatPath) ? flatPath : indexPath;
              const handler = await import(/* @vite-ignore */ handlerPath + '?t=' + Date.now());
              await handler.default(req, res);

            } catch (err) {
              console.error('[api-dev-server] Handler error:', err.message);
              if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({
                  success: false,
                  error: 'API handler failed',
                  details: err.message
                }));
              }
            }
          });
        }
      },

      mode === 'analyze' && visualizer({
        filename: 'bundle-analysis.html',
        open: true,
        gzipSize: true,
        brotliSize: true
      }),
      mode === 'production' && viteCompression({
        algorithm: 'gzip',
        ext: '.gz',
        deleteOriginFile: false
      })
    ].filter(Boolean)
  }
})