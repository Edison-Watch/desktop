import { defineConfig, externalizeDepsPlugin, loadEnv } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(__dirname, "..");
const frontendDir = resolve(projectRoot, "frontend");

export default defineConfig(({ mode }) => {
  // Load VITE_ vars from frontend/.env.<mode> so all bundles share the same source of truth
  const env = loadEnv(mode, frontendDir, "VITE_");

  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      // Expose VITE_DEPLOY_ENV to the main process at build time
      define: {
        "import.meta.env.VITE_DEPLOY_ENV": JSON.stringify(env["VITE_DEPLOY_ENV"] ?? ""),
      },
    },
    preload: {
      plugins: [externalizeDepsPlugin({ exclude: ["@electron-toolkit/preload"] })],
    },
    renderer: {
      plugins: [react(), tailwindcss()],
      envDir: frontendDir,
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
  };
});
