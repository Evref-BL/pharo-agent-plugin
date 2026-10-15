import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configuredActiveImageId } from "../src/project.js";

function temporaryProject(images) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-project-"));
  fs.writeFileSync(path.join(root, "plexus.project.json"), `${JSON.stringify({ images })}\n`);
  return root;
}

test("selects the one active PLexus image", () => {
  const root = temporaryProject([
    { id: "inactive", active: false },
    { id: "agent", active: true },
  ]);
  try {
    assert.equal(configuredActiveImageId(root), "agent");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("refuses ambiguous PLexus image configuration", () => {
  const root = temporaryProject([
    { id: "first", active: true },
    { id: "second", active: true },
  ]);
  try {
    assert.throws(() => configuredActiveImageId(root), /exactly one active image/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
