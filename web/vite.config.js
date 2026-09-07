import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Dev only. In production the API must send real CORS headers,
    // or be served from the same domain.
    proxy: { "/api": "http://localhost:3000" },
  },
});
