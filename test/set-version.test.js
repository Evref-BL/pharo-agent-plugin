import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "package.json",
  "plugin.json",
  ".claude-plugin/plugin.json",
  "skills/pharo-feedback/SKILL.md",
];

test("set-version moves every reference to the release", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-version-"));
  try {
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(directory, file));
    }

    execFileSync(process.execPath, [path.join(root, "scripts", "set-version.mjs"), "0.1.1"], { cwd: directory });

    const read = (file) => fs.readFileSync(path.join(directory, file), "utf8");
    for (const file of files.slice(0, 3)) {
      assert.equal(JSON.parse(read(file)).version, "0.1.1", file);
    }
    assert.match(read("skills/pharo-feedback/SKILL.md"), /`pharo-agent 0\.1\.1`/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
