#!/usr/bin/env node
// Fails (exit 1) if any tracked source file contains an em dash (U+2014).
// Em dashes are a common tell for AI-generated text and should not leak into
// the codebase. Markdown and a few data/lock files are exempt because prose
// docs legitimately use em dashes for typography.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const EM_DASH = "—";

// Extensions / paths where em dashes are allowed (prose, generated, binary).
const EXEMPT_EXTENSIONS = new Set([".md", ".mdx", ".markdown"]);
const EXEMPT_FILES = new Set(["package-lock.json"]);

function extOf(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

function listTrackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { encoding: "buffer" });
  return out
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

const offenders = [];
for (const file of listTrackedFiles()) {
  if (EXEMPT_FILES.has(file) || EXEMPT_EXTENSIONS.has(extOf(file))) continue;

  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue; // unreadable / binary — skip
  }
  if (!content.includes(EM_DASH)) continue;

  content.split("\n").forEach((line, i) => {
    if (line.includes(EM_DASH)) {
      offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    }
  });
}

if (offenders.length > 0) {
  console.error(
    `Found ${offenders.length} em dash(es) (U+2014 "${EM_DASH}"). ` +
      "Replace them with a hyphen, comma, or rewrite:\n",
  );
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}

console.log('No em dashes found.');
