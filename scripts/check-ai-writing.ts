#!/usr/bin/env bun
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const SELF = resolve(fileURLToPath(import.meta.url));
const EM_DASH = "\u2014";
const ROOT_SKIP = new Set([".git", ".venv", "node_modules", "dist", "build", "target", ".next", "coverage", ".cache"]);
const REC_SKIP = new Set(["__pycache__", "node_modules", "dist", "target", ".next"]);
const SKIP_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".mp4", ".mov",
  ".mp3", ".woff", ".woff2", ".ttf", ".otf", ".pdf", ".zip", ".gz", ".bin", ".lock"]);
const CONTRASTIVE: RegExp[] = [
  /\bnot (?:just|only|merely|simply)\b[^.?!\n]{0,60}?\bbut\b/i,
  /\b(?:it'?s|that'?s|this is)\s+not\b[^.?!\n]{0,60}?,?\s*(?:it'?s|that'?s|they'?re)\b/i,
  /\b(?:isn'?t|aren'?t|wasn'?t|weren'?t)\s+(?:just|only|merely|simply)\b/i,
  /\b(?:isn'?t|aren'?t)\s+(?:just\s+)?about\b[^.?!\n]{0,60}?\bit'?s about\b/i,
  /\bmore than just\b/i,
  /\bless about\b[^.?!\n]{0,60}?\bmore about\b/i,
  /\bnot\b[^.?!\n]{0,40}?\bso much as\b/i,
  /\bgoes? beyond\b/i, // noisiest; drop if it over-flags
];

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const top = relative(REPO_ROOT, full).split("/")[0];
    if (ROOT_SKIP.has(top)) continue;
    if (statSync(full).isDirectory()) {
      if (REC_SKIP.has(name)) continue;
      yield* walk(full);
    } else {
      if (resolve(full) === SELF || SKIP_EXT.has(extname(full).toLowerCase())) continue;
      yield full;
    }
  }
}

const em: string[] = [], contra: string[] = [];
for (const file of walk(REPO_ROOT)) {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { continue; }
  const rel = relative(REPO_ROOT, file);
  text.split("\n").forEach((line, i) => {
    if (line.includes(EM_DASH)) em.push(`${rel}:${i + 1}: ${line.trim()}`);
    if (CONTRASTIVE.some((re) => re.test(line))) contra.push(`${rel}:${i + 1}: ${line.trim()}`);
  });
}
if (em.length || contra.length) {
  if (em.length) { console.log("AI writing check failed: em dash (U+2014) detected"); console.log(em.join("\n")); }
  if (contra.length) { console.log("AI writing check failed: contrastive parallelism ('not just X, but Y') detected"); console.log(contra.join("\n")); }
  console.log("Remove the flagged construction or explain why it is acceptable.");
  process.exit(1);
}
console.log("AI writing check passed.");
