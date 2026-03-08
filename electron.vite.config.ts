import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(__dirname, "..");

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["@electron-toolkit/preload"] })],
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    envDir: resolve(projectRoot, "frontend"),
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer/src"),
        "@edison/shared": resolve(projectRoot, "packages/shared/src"),
      },
      dedupe: ["@supabase/supabase-js"],
    },
    optimizeDeps: {
      include: ["@supabase/supabase-js"],
    },
    server: {
      fs: {
        allow: [projectRoot],
      },
    },
  },
});
