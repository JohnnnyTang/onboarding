import { defineConfig } from "vite";

export default defineConfig({
  server: { host: "127.0.0.1", port: 4313, strictPort: true },
  build: { outDir: ".scratch/table-dev", rollupOptions: { input: "dev/table/index.html" } },
});
