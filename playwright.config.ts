import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  retries: 0,
  workers: 1, // Electron tests must run serially
  // HTML report + list output; the report is uploaded as a CI artifact on failure.
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    // retries: 0, so "on-first-retry" would never capture anything - retain on
    // failure instead so CI has a trace + screenshot to inspect (see e2e.yml).
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
