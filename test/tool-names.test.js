import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import { imageToolNames } from "../src/mcpServer.js";

/**
 * Every piece of text a module writes: its string literals and the text of
 * its templates.
 *
 * @param {URL} file
 */
function stringsOf(file) {
  const source = ts.createSourceFile(file.pathname, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  /** @type {string[]} */
  const found = [];
  /** @param {import("typescript").Node} node */
  const visit = (node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// A text naming a tool the server does not serve sends an agent to look for
// it. live.js is left out: it calls the image's own image_evaluate.
test("the image tools the texts name are the ones the server serves", () => {
  const served = new Set(imageToolNames);
  /** @type {Map<string, string>} */
  const named = new Map();
  for (const module of ["answers.js", "gateway.js", "project.js", "mcpServer.js"]) {
    for (const text of stringsOf(new URL(`../src/${module}`, import.meta.url))) {
      for (const [tool] of text.matchAll(/image_[a-z]+/g)) named.set(tool, module);
    }
  }

  assert.ok(named.size > 0);
  assert.deepEqual([...named].filter(([tool]) => !served.has(tool)), []);
  assert.deepEqual(imageToolNames, ["image_templates", "image_create", "image_list", "image_start", "image_stop", "image_delete"]);
});
