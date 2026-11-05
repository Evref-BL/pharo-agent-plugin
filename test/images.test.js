import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

// The record `image start` writes, and the PLexus state it points at, saying
// the image runs as `pid`: this test's own process unless told otherwise.
function runImage(root, imageId, pid = process.pid) {
  const statePath = path.join(root, "state.json");
  fs.writeFileSync(statePath, `${JSON.stringify({ images: [{ id: imageId, status: "running", pid }] })}\n`);
  writeRunningImages(root, {
    [imageId]: { statePath, imageId, mcpServerId: imageId, mountPath: "/tmp/mount", projectionPort: 1 },
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
    // A template PLexus expands at launch, rather than the project name
    // baked in when the image was declared.
    assert.equal(added.imageName, "{projectName}-{workspaceId}-dev");
    const [image] = configuredImages(root);
    // The policy is PLexus's default, so the declaration does not repeat it.
    assert.equal(image.mcp.loadPolicy, undefined);
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
    // PLexus owns the declaration, so PLexus refuses the duplicate.
    assert.throws(
      () => addImage(root, { id: "dev", template: "Pharo 12" }),
      /already declared/,
    );
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

test("an image whose process has exited is listed as exited, not running", () => {
  const root = temporaryProject();
  try {
    addImage(root, { id: "dev", template: "Pharo 13" });
    runImage(root, "dev", spawnSync(process.execPath, ["-e", ""]).pid);

    const [listed] = listImages(root).images;
    assert.equal(listed.running, false);
    assert.equal(listed.exited, true);
    assert.equal(listed.mountPath, undefined, "the mount of an image that is gone leads nowhere");
    assert.equal(listed.projectionPort, undefined);
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
