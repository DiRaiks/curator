import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri launches Vite on a fixed port and consumes the dev URL from
// `tauri.conf.json` (devUrl). Keep these aligned.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "esnext",
    sourcemap: true,
  },
});
