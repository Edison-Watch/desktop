import { test } from "@playwright/test";
import { readFileSync, mkdirSync } from "fs";
import { join } from "path";

/**
 * Visual regression screenshot + video generator for client_2 Storybook.
 *
 * Reads storybook-static/index.json to discover all stories, navigates to each,
 * captures a full-page PNG screenshot AND a WebM recording of the story loading.
 *
 * PNGs and WebMs are uploaded to the visual-tests service in CI for comparison.
 * Tag a story with "no-visual-test" to skip it.
 */

interface StoryEntry {
  id: string;
  title: string;
  name: string;
  type: "story" | "docs" | "group";
  tags?: string[];
}

interface StorybookIndex {
  v: number;
  entries: Record<string, StoryEntry>;
}

// Paths relative to process.cwd() (client_2 project root)
const SCREENSHOT_DIR = join(process.cwd(), "tests/visual/screenshots");
const STORYBOOK_INDEX = join(process.cwd(), "storybook-static/index.json");
const SETTLE_DELAY_MS = 500;

function discoverStories(): StoryEntry[] {
  const raw = readFileSync(STORYBOOK_INDEX, "utf-8");
  const index: StorybookIndex = JSON.parse(raw);
  return Object.values(index.entries).filter(
    (e) => e.type === "story" && !e.tags?.includes("no-visual-test"),
  );
}

const stories = discoverStories();
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const storyIdByTitle = new Map<string, string>();

for (const story of stories) {
  const title = `screenshot: ${story.title} / ${story.name}`;
  storyIdByTitle.set(title, story.id);

  test(title, async ({ page }) => {
    const params = new URLSearchParams({ id: story.id, viewMode: "story" });
    await page.goto(`/iframe.html?${params.toString()}`);
    // Wait for the story to actually render (not just the root element to exist),
    // so the video recording captures the rendered UI rather than the loading spinner.
    await page.waitForSelector("#storybook-root > *");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(SETTLE_DELAY_MS);

    await page.evaluate(() => {
      document.querySelectorAll("[data-visual-test-ignore]").forEach((el) => {
        (el as HTMLElement).style.visibility = "hidden";
      });
    });

    await page.screenshot({
      path: join(SCREENSHOT_DIR, `${story.id}.png`),
      fullPage: true,
      animations: "disabled",
    });
  });
}

test.afterEach(async ({ page }, testInfo) => {
  const storyId = storyIdByTitle.get(testInfo.title);
  if (!storyId) return;

  const video = page.video();
  if (!video) return;

  try {
    await page.close();
    await video.saveAs(join(SCREENSHOT_DIR, `${storyId}.webm`));
  } catch {
    // Video capture is best-effort
  }
});
