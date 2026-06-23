import { defineConfig, externalizeDepsPlugin, loadEnv } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(__dirname, "..");
const frontendDir = resolve(projectRoot, "frontend-v2");

export default defineConfig(({ mode }) => {
  // Load VITE_ vars from frontend-v2/.env.<mode> - single source of truth for all bundles.
  const env = loadEnv(mode, frontendDir, "VITE_");

  return {
    main: {
      plugins: [externalizeDepsPlugin({ exclude: ["@edison/shared"] })],
      // Expose env vars to the main process at build time.
      define: {
        "import.meta.env.VITE_DEPLOY_ENV": JSON.stringify(env["VITE_DEPLOY_ENV"] ?? ""),
        "import.meta.env.VITE_API_BASE_URL": JSON.stringify(env["VITE_API_BASE_URL"] ?? ""),
        "import.meta.env.VITE_MCP_BASE_URL": JSON.stringify(env["VITE_MCP_BASE_URL"] ?? ""),
      },
      resolve: {
        alias: {
          "@edison/shared": resolve(projectRoot, "shared/src"),
        },
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
          "@edison/shared": resolve(projectRoot, "shared/src"),
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
