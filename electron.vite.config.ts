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
      plugins: [externalizeDepsPlugin({ exclude: ["@edison-watch/shared"] })],
      // Expose env vars to the main process at build time.
      define: {
        "import.meta.env.VITE_DEPLOY_ENV": JSON.stringify(env["VITE_DEPLOY_ENV"] ?? ""),
        "import.meta.env.VITE_API_BASE_URL": JSON.stringify(env["VITE_API_BASE_URL"] ?? ""),
        "import.meta.env.VITE_MCP_BASE_URL": JSON.stringify(env["VITE_MCP_BASE_URL"] ?? ""),
        // Compact (trimmed) Linux tray menu. Baked at build time so we can ship
        // two Linux variants: default = compact; set EDISON_TRAY_COMPACT=0 for
        // the full menu. Only affects Linux (the menu code gates on platform).
        __TRAY_COMPACT__: JSON.stringify((process.env.EDISON_TRAY_COMPACT ?? "1") !== "0"),
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
