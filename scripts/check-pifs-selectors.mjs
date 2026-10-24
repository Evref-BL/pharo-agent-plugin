#!/usr/bin/env node
// Fails when a published pharo-image-fs no longer implements a class-side
// PIFSServer selector this plugin sends. The plugin's own tests cannot catch
// that: they read generated Smalltalk source, which a pin bump does not change,
// so a breaking component release otherwise produces a green pull request that
// only fails once an image tries to start a projection.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pifsSelectors } from "../src/live.js";

// Tonel writes one method header per line, as `PIFSServer class >> sig [`.
export function classSideSelectors(source) {
  const selectors = new Set();
  for (const line of source.split("\n")) {
    const header = /^PIFSServer class >> (.+?) \[\s*$/.exec(line);
    if (!header) continue;
    const signature = header[1].trim();
    const keywords = signature.match(/[A-Za-z0-9_]+:/g);
    selectors.add(keywords ? keywords.join("") : signature);
  }
  return selectors;
}

export function missingSelectors(source, selectors = pifsSelectors) {
  const implemented = classSideSelectors(source);
  return selectors.filter((selector) => !implemented.has(selector));
}

function main(sourcePath) {
  if (!sourcePath) {
    console.error("usage: check-pifs-selectors.mjs <PIFSServer.class.st>");
    process.exit(2);
  }
  const source = fs.readFileSync(sourcePath, "utf8");
  const missing = missingSelectors(source);
  if (missing.length > 0) {
    console.error(`PIFSServer no longer implements: ${missing.join(", ")}`);
    console.error("Update pifsStartCode and pifsSelectors in src/live.js for this release.");
    console.error(`It implements: ${[...classSideSelectors(source)].sort().join(", ")}`);
    process.exit(1);
  }
  console.log(`PIFSServer implements all ${pifsSelectors.length} selectors the plugin sends.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]);
}
