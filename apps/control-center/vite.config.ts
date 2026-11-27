import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/control/",
  mode: "control",
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", target: "chrome105" },
});
