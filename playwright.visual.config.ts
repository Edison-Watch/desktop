import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for visual regression screenshot + video capture (client_2).
 *
 * Serves the static Storybook build (storybook-static/) via http-server on port 6009.
 * Runs separately from playwright.config.ts (which targets the full Electron app).
 */
export default defineConfig({
  testDir: "./tests/visual",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : 4,
  timeout: 60_000,
  reporter: [["list"]],

  use: {
    baseURL: "http://localhost:6009",
    viewport: { width: 460, height: 680 },
    trace: "off",
    screenshot: "off",
    // Record video for every story — enables animation regression detection
    video: "on",
  },

  projects: [
    {
      name: "desktop-chrome",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    command: "npx http-server storybook-static -p 6009 --silent",
    url: "http://localhost:6009",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
