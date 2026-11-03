import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The Keycloak client allows redirects to http://localhost:5173 only (infra/keycloak).
export default defineConfig({
  plugins: [react()],
  server: { host: "localhost", port: 5173, strictPort: true },
  preview: { host: "localhost", port: 5173, strictPort: true },
  build: { outDir: "dist", sourcemap: true },
});
