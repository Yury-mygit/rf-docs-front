const SERVER_URL = process.env.SERVER_URL || 'http://127.0.0.1:8023';

export default {
  base: '/',
  server: {
    host: '0.0.0.0',
    port: 5186,
    strictPort: true,
    allowedHosts: ['docs.dev.raftforge.art'],
    proxy: {
      '/api': { target: SERVER_URL, changeOrigin: true },
      '/mcp': { target: SERVER_URL, changeOrigin: true, ws: true }
    }
  }
};
