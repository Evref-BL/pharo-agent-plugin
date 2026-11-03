import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addImage, listImages, removeImage, useImage } from "../src/images.js";
import { createProjectConfig } from "../src/project.js";
import { writeConfig, writeRunningImages } from "../src/runtime.js";

function temporaryProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-images-"));
  createProjectConfig(root);
  fs.mkdirSync(path.join(root, ".pharo-agent"), { recursive: true });
  writeConfig(root, { mountRoot: ".pharo-agent/mounts" });
  return root;
}

function runImage(root, imageId) {
  writeRunningImages(root, {
    [imageId]: { imageId, mcpServerId: "server", mountPath: "/tmp/mount", projectionPort: 1 },
  });
}

function configuredImages(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "plexus.json"), "utf8")).images;
}

test("the first registered image becomes the default one", () => {
  const root = temporaryProject();
  try {
    const added = addImage(root, { id: "dev", template: "Pharo 13.0 - 64bit (stable)" });

    assert.equal(added.isDefault, true);
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

test("a later registered image is declared without taking the default", () => {
  const root = temporaryProject();
  try {
    addImage(root, { id: "dev", template: "Pharo 13" });
    const second = addImage(root, { id: "ci", template: "Pharo 12", category: "Official" });

    assert.equal(second.isDefault, false);
    // PLexus stopped reading `active` when it stopped reconciling declarations
    // against what is running, so a declaration no longer carries one.
    assert.deepEqual(configuredImages(root).map((image) => image.active), [undefined, undefined]);
    assert.deepEqual(listImages(root).images.map((image) => image.isDefault), [true, false]);

    assert.deepEqual(useImage(root, "ci"), { defaultImage: "ci" });
    assert.deepEqual(listImages(root).images.map((image) => image.isDefault), [false, true]);
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

test("a running image cannot be removed", () => {
  const root = temporaryProject();
  try {
    addImage(root, { id: "dev", template: "Pharo 13" });
    runImage(root, "dev");

    assert.throws(() => removeImage(root, "dev"), /Run pharo-agent image stop dev/);
    assert.deepEqual(configuredImages(root).map((image) => image.id), ["dev"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the default image can change while another image is running", () => {
  const root = temporaryProject();
  try {
    addImage(root, { id: "dev", template: "Pharo 13" });
    addImage(root, { id: "ci", template: "Pharo 12" });
    runImage(root, "dev");

    assert.deepEqual(useImage(root, "ci"), { defaultImage: "ci" });
    assert.equal(listImages(root).defaultImage, "ci");
    assert.deepEqual(
      listImages(root).images.map((image) => image.running),
      [true, false],
    );
    // The list carries what `status` used to answer separately.
    assert.deepEqual(
      listImages(root).images.map((image) => image.projectionPort),
      [1, undefined],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("removing the default image clears it", () => {
  const root = temporaryProject();
  try {
    addImage(root, { id: "dev", template: "Pharo 13" });
    addImage(root, { id: "ci", template: "Pharo 12" });

    removeImage(root, "dev");
    assert.equal(listImages(root).defaultImage, "ci");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an image that is not running is removed", () => {
  const root = temporaryProject();
  try {
    addImage(root, { id: "dev", template: "Pharo 13" });
    addImage(root, { id: "ci", template: "Pharo 12" });
    runImage(root, "dev");

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
