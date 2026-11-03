import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjectConfigFile, declareProjectImage } from "@evref-bl/plexus";
import { defaultImageId, resolveImageId, writeConfig } from "../src/runtime.js";

// Built by the API that writes real configs, so the fixture cannot describe a
// project PLexus would refuse to load. These used to be hand-written objects
// with no config id, no image name and no load script — a shape nothing could
// ever have run.
function temporaryProject(imageIds, pluginConfig = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-project-"));
  createProjectConfigFile(root, { name: path.basename(root) });
  for (const id of imageIds) {
    declareProjectImage(root, {
      id,
      templateName: "Pharo 14.0 - 64bit",
      loadScript: "pharo/load-mcp.st",
    });
  }
  fs.mkdirSync(path.join(root, ".pharo-agent"), { recursive: true });
  writeConfig(root, pluginConfig);
  return root;
}

test("the only configured image is the default", () => {
  const root = temporaryProject(["dev"]);
  try {
    assert.equal(defaultImageId(root), "dev");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the chosen default wins over declaration order", () => {
  const root = temporaryProject(
    ["dev", "ci"],
    { defaultImage: "ci" },
  );
  try {
    assert.equal(defaultImageId(root), "ci");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("several configured images without a default are reported, not guessed", () => {
  const root = temporaryProject(["dev", "ci"]);
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
  const root = temporaryProject(["dev"], { defaultImage: "gone" });
  try {
    assert.throws(() => defaultImageId(root), /not configured/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit image must be configured", () => {
  const root = temporaryProject(["dev", "ci"]);
  try {
    assert.equal(resolveImageId(root, "ci"), "ci");
    assert.throws(() => resolveImageId(root, "other"), /Image other is not configured/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
