import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultImageId, resolveImageId, writeConfig } from "../src/runtime.js";

function temporaryProject(images, pluginConfig = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-project-"));
  fs.writeFileSync(path.join(root, "plexus.project.json"), `${JSON.stringify({ images })}\n`);
  fs.mkdirSync(path.join(root, ".pharo-agent"), { recursive: true });
  writeConfig(root, pluginConfig);
  return root;
}

test("the only configured image is the default", () => {
  const root = temporaryProject([{ id: "dev", active: true }]);
  try {
    assert.equal(defaultImageId(root), "dev");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the chosen default wins over declaration order", () => {
  const root = temporaryProject(
    [{ id: "dev", active: true }, { id: "ci", active: true }],
    { defaultImage: "ci" },
  );
  try {
    assert.equal(defaultImageId(root), "ci");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("several configured images without a default are reported, not guessed", () => {
  const root = temporaryProject([{ id: "dev", active: true }, { id: "ci", active: true }]);
  try {
    assert.throws(() => defaultImageId(root), /dev, ci/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a project with no configured image points at image add", () => {
  const root = temporaryProject([]);
  try {
    assert.throws(() => defaultImageId(root), /pharo-agent image add/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a stale default is reported instead of silently ignored", () => {
  const root = temporaryProject([{ id: "dev", active: true }], { defaultImage: "gone" });
  try {
    assert.throws(() => defaultImageId(root), /not configured/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit image must be configured", () => {
  const root = temporaryProject([{ id: "dev", active: true }, { id: "ci", active: true }]);
  try {
    assert.equal(resolveImageId(root, "ci"), "ci");
    assert.throws(() => resolveImageId(root, "other"), /Image other is not configured/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
