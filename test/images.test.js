import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addImage, listImages, removeImage, useImage } from "../src/images.js";
import { createProjectConfig } from "../src/project.js";
import { writeActive } from "../src/runtime.js";

function temporaryProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-images-"));
  createProjectConfig(root);
  return root;
}

function configuredImages(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "plexus.project.json"), "utf8")).images;
}

test("the first registered image becomes the active one", () => {
  const root = temporaryProject();
  try {
    const added = addImage(root, { id: "dev", template: "Pharo 13.0 - 64bit (stable)" });

    assert.equal(added.active, true);
    assert.equal(added.imageName, `${path.basename(root)}-{workspaceId}-dev`);
    const [image] = configuredImages(root);
    assert.equal(image.mcp.loadPolicy, "ifMissing");
    assert.equal(image.create.kind, "template");
    assert.equal(image.create.templateName, "Pharo 13.0 - 64bit (stable)");
    assert.equal(image.mcp.port, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a later registered image stays inactive until it is selected", () => {
  const root = temporaryProject();
  try {
    addImage(root, { id: "dev", template: "Pharo 13" });
    const second = addImage(root, { id: "ci", template: "Pharo 12", category: "Official" });

    assert.equal(second.active, false);
    assert.deepEqual(listImages(root).images.map((image) => image.active), [true, false]);

    useImage(root, "ci");
    assert.deepEqual(listImages(root).images.map((image) => image.active), [false, true]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("registering a duplicate image id is refused", () => {
  const root = temporaryProject();
  try {
    addImage(root, { id: "dev", template: "Pharo 13" });
    assert.throws(() => addImage(root, { id: "dev", template: "Pharo 12" }), /already configured/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an open image cannot be removed or deselected", () => {
  const root = temporaryProject();
  try {
    addImage(root, { id: "dev", template: "Pharo 13" });
    addImage(root, { id: "ci", template: "Pharo 12" });
    writeActive(root, { imageId: "dev", mcpServerId: "server", mountPath: "/tmp/mount" });

    assert.throws(() => removeImage(root, "dev"), /Run pharo-agent close/);
    assert.throws(() => useImage(root, "ci"), /Run pharo-agent close/);
    assert.deepEqual(configuredImages(root).map((image) => image.id), ["dev", "ci"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an unopened image is removed", () => {
  const root = temporaryProject();
  try {
    addImage(root, { id: "dev", template: "Pharo 13" });
    addImage(root, { id: "ci", template: "Pharo 12" });
    writeActive(root, { imageId: "dev", mcpServerId: "server", mountPath: "/tmp/mount" });

    assert.deepEqual(removeImage(root, "ci"), { removedImageId: "ci" });
    assert.deepEqual(configuredImages(root).map((image) => image.id), ["dev"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("removing an image that is not configured is refused", () => {
  const root = temporaryProject();
  try {
    assert.throws(() => removeImage(root, "dev"), /not configured/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
