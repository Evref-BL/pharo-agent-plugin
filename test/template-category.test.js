import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addImage } from "../src/images.js";
import { resolveTemplateCategory } from "../src/live.js";
import { createProjectConfig } from "../src/project.js";
import { writeConfig } from "../src/runtime.js";

function temporaryProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-category-"));
  createProjectConfig(root);
  fs.mkdirSync(path.join(root, ".pharo-agent"), { recursive: true });
  writeConfig(root, { mountRoot: ".pharo-agent/mounts" });
  return root;
}

function launcherListing(templates) {
  return { listTemplates: async () => ({ templates }) };
}

function storedCreate(root, imageId) {
  const { images } = JSON.parse(fs.readFileSync(path.join(root, "plexus.json"), "utf8"));
  return images.find((image) => image.id === imageId).create;
}

test("the category of a named template is found and recorded", async () => {
  const root = temporaryProject();
  try {
    addImage(root, { id: "dev", template: "Moose Suite 12 (stable)" });
    const launcher = launcherListing([
      { name: "Pharo 13.0 - 64bit (stable)", templateCategory: "Official distributions" },
      { name: "Moose Suite 12 (stable)", templateCategory: "Moose distributions" },
    ]);

    const category = await resolveTemplateCategory(root, launcher, "dev");

    assert.equal(category, "Moose distributions");
    assert.equal(storedCreate(root, "dev").templateCategory, "Moose distributions");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a category already recorded is kept without listing templates", async () => {
  const root = temporaryProject();
  try {
    addImage(root, { id: "dev", template: "Pharo 13.0 - 64bit (stable)" });
    const launcher = launcherListing([
      { name: "Pharo 13.0 - 64bit (stable)", templateCategory: "Deprecated distributions" },
    ]);
    await resolveTemplateCategory(root, launcher, "dev");

    const category = await resolveTemplateCategory(root, {
      listTemplates: async () => {
        throw new Error("templates must not be listed again");
      },
    }, "dev");

    assert.equal(category, "Deprecated distributions");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a template in several categories asks for one to be chosen", async () => {
  const root = temporaryProject();
  try {
    addImage(root, { id: "dev", template: "Pharo 13.0 - 64bit (stable)" });
    const launcher = launcherListing([
      { name: "Pharo 13.0 - 64bit (stable)", templateCategory: "Official distributions" },
      { name: "Pharo 13.0 - 64bit (stable)", templateCategory: "Deprecated distributions" },
    ]);

    await assert.rejects(
      () => resolveTemplateCategory(root, launcher, "dev"),
      /several categories: Official distributions, Deprecated distributions/,
    );
    assert.equal(storedCreate(root, "dev").templateCategory, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a template no category offers is reported", async () => {
  const root = temporaryProject();
  try {
    addImage(root, { id: "dev", template: "Pharo 99.0" });

    await assert.rejects(
      () => resolveTemplateCategory(root, launcherListing([]), "dev"),
      /No template named Pharo 99\.0 in any category/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
