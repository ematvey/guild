import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The admin console is a separate app served by the guild-server binary at
// /admin (the shared chat app lives at /). Same origin, shared auth.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/admin/",
  server: { port: 1421, strictPort: true },
  build: { outDir: "dist", target: "chrome105" },
});
