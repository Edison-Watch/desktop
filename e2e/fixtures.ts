import { test as base, type ElectronApplication, type Page, _electron as electron } from "@playwright/test";
import { join } from "path";

/**
 * Custom test fixture that launches the Electron app and provides
 * the ElectronApplication and first window Page.
 *
 * Expects the app to be built first via `npm run build` (electron-vite build).
 * In CI, set EDISON_TEST_MODE=1 to skip real auth and backend calls.
 */
export const test = base.extend<{
  electronApp: ElectronApplication;
  firstWindow: Page;
}>({
  // eslint-disable-next-line no-empty-pattern
  electronApp: async ({}, use) => {
    const mainPath = join(__dirname, "../out/main/index.js");

    const app = await electron.launch({
      args: [mainPath],
      env: {
        ...process.env,
        NODE_ENV: "test",
        EDISON_TEST_MODE: "1",
      },
    });

    await use(app);
    await app.close();
  },

  firstWindow: async ({ electronApp }, use) => {
    const window = await electronApp.firstWindow();
    // Wait for the renderer to fully load
    await window.waitForLoadState("domcontentloaded");
    await use(window);
  },
});

export { expect } from "@playwright/test";
