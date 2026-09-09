import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Served by the guild-server binary at the root.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/",
  server: { port: 1421, strictPort: true },
  build: { outDir: "dist", target: "chrome105" },
});
