import { defineConfig } from "vite";

export default defineConfig({
  // Proxy /api/* to the Vercel dev server during local development.
  // Run `vercel dev` (which starts on port 3000 by default) alongside
  // `vite` (port 5173) and this proxy will forward API calls transparently.
  server: {
    proxy: {
      "/api": {
        target:       "http://localhost:3000",
        changeOrigin: true,
      }
    }
  }
});
