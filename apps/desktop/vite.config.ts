import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri launches Vite on a fixed port and consumes the dev URL from
// `tauri.conf.json` (devUrl). Keep these aligned.
export default defineConfig({
  plugins: [react()],
  // Emit relative asset URLs (./assets/…) instead of absolute (/assets/…).
  // The packaged WebView serves the bundled frontend over a custom protocol
  // whose origin root isn't guaranteed across Tauri/wry builds; relative
  // paths resolve against the document URL and load reliably everywhere.
  // Absolute paths produced a blank window on some machines.
  base: "./",
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
