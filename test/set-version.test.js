import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("set-version synchronizes published version references", () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-version-"));
  try {
    fs.mkdirSync(path.join(temporaryDirectory, ".claude-plugin"));
    for (const file of ["package.json", "plugin.json", ".claude-plugin/plugin.json"]) {
      fs.copyFileSync(path.join(root, file), path.join(temporaryDirectory, file));
    }
    for (const skill of ["pharo-setup", "pharo-feedback"]) {
      fs.mkdirSync(path.join(temporaryDirectory, "skills", skill), { recursive: true });
      fs.copyFileSync(
        path.join(root, "skills", skill, "SKILL.md"),
        path.join(temporaryDirectory, "skills", skill, "SKILL.md"),
      );
    }

    execFileSync(process.execPath, [path.join(root, "scripts", "set-version.mjs"), "0.1.1"], {
      cwd: temporaryDirectory,
    });

    for (const file of ["package.json", "plugin.json", ".claude-plugin/plugin.json"]) {
      assert.equal(JSON.parse(fs.readFileSync(path.join(temporaryDirectory, file), "utf8")).version, "0.1.1");
    }
    assert.match(
      fs.readFileSync(path.join(temporaryDirectory, "skills", "pharo-setup", "SKILL.md"), "utf8"),
      /@evref-bl\/pharo-agent@0\.1\.1 init --host claude/,
    );
    assert.match(
      fs.readFileSync(path.join(temporaryDirectory, "skills", "pharo-feedback", "SKILL.md"), "utf8"),
      /`pharo-agent 0\.1\.1`/,
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
