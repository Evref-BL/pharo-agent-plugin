import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// update-pifs.yml reads the PIFS pin out of a source file with sed and writes
// it back. A declaration that moves leaves the workflow reading a path that no
// longer answers, and the update stops without moving the pin. PLexus lost a
// release notification to exactly that, so the plugin checks it here.
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workflow = path.join(repoRoot, ".github", "workflows", "update-pifs.yml");

// The expression the workflow uses, kept identical on purpose.
const declaration = /^export const pifsRelease = "v(\d+\.\d+\.\d+)";$/m;

test("the file update-pifs.yml pins PIFS in still declares the pin", () => {
  const text = fs.readFileSync(workflow, "utf8");
  const named = text.match(/pin_file="([^"]+)"/);
  assert.ok(named, "update-pifs.yml no longer names a pin file");

  const pinned = path.join(repoRoot, named[1]);
  assert.ok(fs.existsSync(pinned), `${named[1]} does not exist`);
  assert.match(fs.readFileSync(pinned, "utf8"), declaration,
    `${named[1]} does not declare pifsRelease`);
});

test("the PIFS pin is declared once, so the workflow cannot rewrite a copy", () => {
  const source = path.join(repoRoot, "src");
  const declaring = fs.readdirSync(source)
    .filter((name) => name.endsWith(".js"))
    .filter((name) => declaration.test(fs.readFileSync(path.join(source, name), "utf8")));
  assert.deepEqual(declaring, ["live.js"], `declared in: ${declaring.join(", ")}`);
});
