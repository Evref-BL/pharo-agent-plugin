import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createImage,
  deleteImage,
  listImageTemplates,
  listImages,
  olderMcpWarning,
  useImage,
} from "../src/images.js";
import { readConfig, writeConfig } from "../src/project.js";
import { readProjection, recordProjection } from "../src/runtime.js";
import {
  callsOf,
  defaultPharoMcpVersion,
  pinnedImage,
  readWorld,
  runningImage,
  useFakePlexus,
} from "./support/fake-plexus.js";

const template = "Pharo 14.0 - 64bit (stable)";

/**
 * A project and a fake PLexus store, both dropped afterwards.
 *
 * @param {(root: string) => Promise<void>} run
 * @param {Parameters<typeof useFakePlexus>[0]} [world]
 * @param {Record<string, unknown>} [config]
 */
async function inProject(run, world = {}, config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-images-"));
  const dropStore = useFakePlexus(world);
  try {
    writeConfig(root, { scope: "proj", mountRoot: ".pharo-agent/mounts", ...config });
    await run(root);
  } finally {
    dropStore();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("an image is created in the project's scope", async () => {
  await inProject(async (root) => {
    const created = await createImage(root, "dev", { template });

    assert.equal(created.name, "dev");
    assert.equal(created.diskName, "proj-dev");
    assert.deepEqual(Object.keys(readWorld().images), ["proj-dev"]);
    assert.deepEqual(callsOf("create"), [{ op: "create", scope: "proj", name: "dev", options: { template } }]);
  });
});

test("the first image created becomes the default, and only the first", async () => {
  await inProject(async (root) => {
    assert.equal((await createImage(root, "dev", { template })).isDefault, true);
    assert.equal((await createImage(root, "ci", { template })).isDefault, false);
    assert.equal(readConfig(root).defaultImage, "dev");
  });
});

test("a create PLexus refuses leaves the project as it was", async () => {
  await inProject(async (root) => {
    await assert.rejects(
      () => createImage(root, "old", { template: "Pharo 10.0 - 64bit" }),
      (/** @type {any} */ error) => error.code === "ambiguous-template",
    );
    assert.equal(readConfig(root).defaultImage, undefined);
  });
});

test("a script and every-start reach PLexus as given", async () => {
  await inProject(async (root) => {
    const script = path.join(root, "load.st");
    fs.writeFileSync(script, "Transcript show: 'loaded'.\n");
    await createImage(root, "mcp", { template, script, everyStart: true });

    assert.deepEqual(callsOf("create")[0].options, { template, script, everyStart: true });
    assert.deepEqual(readWorld().images["proj-mcp"].mcp, { source: "script", script });
  });
});

test("the default changes only to an image PLexus lists", async () => {
  await inProject(async (root) => {
    await assert.rejects(() => useImage(root, "nope"), (/** @type {any} */ error) => error.code === "no-such-image");
    assert.equal(readConfig(root).defaultImage, "dev");

    assert.deepEqual(await useImage(root, "ci"), { defaultImage: "ci" });
    assert.equal(readConfig(root).defaultImage, "ci");
  }, { images: { "proj-dev": pinnedImage(), "proj-ci": pinnedImage() } }, { defaultImage: "dev" });
});

test("deleting the default image clears the default", async () => {
  await inProject(async (root) => {
    assert.deepEqual(await deleteImage(root, "ci"), { name: "ci" });
    assert.equal(readConfig(root).defaultImage, "dev");

    assert.deepEqual(await deleteImage(root, "dev"), { name: "dev", clearedDefault: true });
    assert.equal(readConfig(root).defaultImage, undefined);
    assert.equal(readConfig(root).scope, "proj", "the rest of the config stays");
    assert.deepEqual(readWorld().images, {});
  }, { images: { "proj-dev": pinnedImage(), "proj-ci": pinnedImage() } }, { defaultImage: "dev" });
});

test("a running image is not deleted, and keeps its place as the default", async () => {
  await inProject(async (root) => {
    await assert.rejects(() => deleteImage(root, "dev"), (/** @type {any} */ error) => error.code === "image-running");
    assert.equal(readConfig(root).defaultImage, "dev");
  }, { images: { "proj-dev": runningImage(41000) } }, { defaultImage: "dev" });
});

test("deleting an image forgets the projection recorded for it", async () => {
  await inProject(async (root) => {
    recordProjection(root, "dev", { mountPath: "/m/dev", projectionPort: 1, pifsRelease: "v0.0.1", pids: [1] });
    recordProjection(root, "ci", { mountPath: "/m/ci", projectionPort: 2, pifsRelease: "v0.0.1", pids: [2] });
    await deleteImage(root, "dev");
    assert.equal(readProjection(root, "dev"), undefined);
    assert.equal(readProjection(root, "ci")?.mountPath, "/m/ci");
  }, { images: { "proj-dev": pinnedImage() } });
});

test("the list is the project's images only, the default marked", async () => {
  await inProject(async (root) => {
    const listed = await listImages(root);

    assert.equal(listed.defaultImage, "ci");
    assert.deepEqual(listed.images.map((image) => [image.name, image.isDefault, image.running]), [
      ["ci", true, false],
      ["dev", false, true],
    ]);
  }, {
    images: {
      "proj-dev": runningImage(41000),
      "proj-ci": pinnedImage(),
      "other-dev": runningImage(42000),
    },
  }, { defaultImage: "ci" });
});

// A record outlives a VM that exits on its own, and the mount it names is
// then gone with it, even once another VM runs the image.
test("the list carries a projection only while the VM that mounted it runs", async () => {
  await inProject(async (root) => {
    recordProjection(root, "dev", { mountPath: "/m/dev", projectionPort: 60341, pifsRelease: "v0.0.1", pids: [91000] });
    recordProjection(root, "ci", { mountPath: "/m/ci", projectionPort: 60342, pifsRelease: "v0.0.1", pids: [92000] });
    recordProjection(root, "qa", { mountPath: "/m/qa", projectionPort: 60343, pifsRelease: "v0.0.1", pids: [5] });
    const byName = Object.fromEntries((await listImages(root)).images.map((image) => [image.name, image]));

    assert.equal(byName.dev.mountPath, "/m/dev");
    assert.equal(byName.dev.projectionPort, 60341);
    assert.equal(byName.ci.mountPath, undefined);
    assert.equal(byName.ci.projectionPort, undefined);
    assert.equal(byName.qa.mountPath, undefined, "qa runs in a VM the record was not made with");
  }, { images: { "proj-dev": runningImage(41000), "proj-ci": pinnedImage(), "proj-qa": runningImage(43000) } });
});

test("an image made with another pin says that recreating it gives the current MCP", async () => {
  await inProject(async (root) => {
    const byName = Object.fromEntries((await listImages(root)).images.map((image) => [image.name, image]));

    assert.match(byName.old.warning ?? "", /^Image old holds Pharo MCP 0\.0\.1/);
    assert.ok(byName.old.warning?.includes(defaultPharoMcpVersion));
    assert.match(byName.old.warning ?? "", /Recreating it gives it the current MCP/);
    assert.equal(byName.current.warning, undefined);
    assert.equal(byName.scripted.warning, undefined, "a script's MCP is its author's");
  }, {
    images: {
      "proj-old": pinnedImage({ mcp: { source: "pin", version: "0.0.1" } }),
      "proj-current": pinnedImage(),
      "proj-scripted": pinnedImage({ mcp: { source: "script", script: "/s/load.st" } }),
    },
  });
});

test("an image with no record of its MCP gets no warning", () => {
  assert.equal(olderMcpWarning({ name: "legacy" }), undefined);
});

test("templates are PLexus's, a name two categories offer marked", async () => {
  await inProject(async (root) => {
    const { templates } = await listImageTemplates(root);
    const old = templates.filter((each) => each.name === "Pharo 10.0 - 64bit");

    assert.equal(old.length, 2);
    assert.ok(old.every((each) => each.ambiguous === true));
    assert.equal(templates.find((each) => each.name === template)?.ambiguous, undefined);
  });
});
