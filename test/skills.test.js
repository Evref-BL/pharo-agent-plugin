import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildSkills, guideSkill, ownSkills, pinnedTemplates } from "../scripts/build-skills.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every file under a directory, with its content and whether it runs. */
function filesOf(directory) {
  return fs
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return {
        file: path.relative(directory, file).split(path.sep).join("/"),
        content: fs.readFileSync(file, "utf8"),
        runs: process.platform === "win32" || (fs.statSync(file).mode & 0o111) !== 0,
      };
    })
    .sort((left, right) => left.file.localeCompare(right.file));
}

test("the skills are the pinned pharo-mcp's, as npm run skills writes them", () => {
  const built = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-skills-"));
  try {
    for (const own of ownSkills) {
      fs.cpSync(path.join(root, "skills", own), path.join(built, own), { recursive: true });
    }
    buildSkills(pinnedTemplates, built);
    assert.deepEqual(filesOf(path.join(root, "skills")), filesOf(built), "run npm run skills and commit what it writes");
  } finally {
    fs.rmSync(built, { recursive: true, force: true });
  }
});

test("every skill has the name of its directory", () => {
  for (const name of fs.readdirSync(path.join(root, "skills"))) {
    const skill = fs.readFileSync(path.join(root, "skills", name, "SKILL.md"), "utf8");
    assert.match(skill, new RegExp(`^---\\nname: ${name}\\ndescription: \\S`), name);
  }
});

test("the guide's links reach files the plugin ships", () => {
  const guide = path.join(root, "skills", guideSkill);
  const text = fs.readFileSync(path.join(guide, "SKILL.md"), "utf8");
  const links = [...text.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);
  assert.ok(links.length > 0);
  for (const link of links) {
    assert.ok(fs.existsSync(path.join(guide, link)), link);
  }
  for (const [, skill] of text.matchAll(/the `(pharo-[a-z-]+)` skill/g)) {
    assert.ok(fs.existsSync(path.join(root, "skills", skill, "SKILL.md")), skill);
  }
  assert.doesNotMatch(text, /skills\/pharo-/);
});
