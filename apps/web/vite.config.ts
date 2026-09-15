import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const controlPlane = process.env.SESSIONBOXER_API ?? "http://127.0.0.1:4000";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": { target: controlPlane, ws: true },
    },
  },
  // Monaco's editor core and TypeScript worker are multi-MB chunks by nature.
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 3000 },
});
